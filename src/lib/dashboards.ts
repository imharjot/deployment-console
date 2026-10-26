// Personal and team dashboards, pins, saved views and log queries, and the home-page preference (requirement 7,
// REVIEW "Turn personal preferences into useful workspaces"). Pure: shared by the stores
// (src/lib/server/dashboards.ts, src/lib/server/workspace.ts), the routes, the UI and the tests (dashboards.test.ts).
//
// A dashboard is an ordered list of widgets on a 12-column grid ({id, type, config, w, h}); phones show one column in
// the same order. Each widget type has a config schema in the operations registry's JSON Schema subset
// (src/lib/ops-schema.ts), which also generates its form. Widgets only read existing APIs, so a dashboard shows exactly
// what its viewer may see: a widget whose API refuses the viewer says which role it needs.
//
// Visibility: `private` (the owner only) or `team` (everyone signed in whose role is at least `minRole`). The owner
// edits; an admin may also edit (and delete) any team dashboard. Nobody else — admins included — sees a private one.
import type { Freshness } from "./freshness.ts";
import { validate } from "./ops-schema.ts";
import { ROLES, isRole, type Role } from "./rbac.ts";
import type { JsonSchema } from "./server/ops/types.ts";

// ---------- limits ----------

export const WORKSPACE_LIMITS = {
  dashboardsPerUser: 50,
  pinsPerUser: 200,
  savedPerUser: 200,
  widgets: 24,
  nameChars: 80,
  descriptionChars: 500,
  titleChars: 60,
  payloadBytes: 64 * 1024, // name + description + widgets, as JSON
  savedPayloadBytes: 8 * 1024,
  incidentCharts: 4, // metric charts the Incident template adds, one per unhealthy service
} as const;

const bytes = (s: string) => new TextEncoder().encode(s).length;
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const unknownFields = (o: Record<string, unknown>, allowed: readonly string[], path = "") =>
  Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${path}${k}: unknown field`);

// ---------- shared field shapes ----------

export const ENV_PATTERN = "^[a-z0-9][a-z0-9-]{0,62}$"; // envOf() in src/lib/server/http.ts
export const REGION_PATTERN = "^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$";
const SERVICE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$";
const KEY_PATTERN = "^[^\\u0000-\\u001f\\u007f]{1,512}$"; // a resource key: "service:api", an ARN, "cloudflare:zone/…"
const METRIC_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$";
const REPO_PATTERN = "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$";
const ONE_LINE = "^[^\\r\\n]*$";
export const ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$"; // dashboard, saved item and widget ids

const reEnv = new RegExp(ENV_PATTERN);
const reRegion = new RegExp(REGION_PATTERN);
const reId = new RegExp(ID_PATTERN);
export const isWorkspaceId = (v: unknown): v is string => typeof v === "string" && reId.test(v);
export const isEnvId = (v: unknown): v is string => typeof v === "string" && reEnv.test(v);
export const isRegionCode = (v: unknown): v is string => typeof v === "string" && reRegion.test(v);

const str = (pattern: string, description?: string, maxLength?: number): JsonSchema => ({ type: "string", pattern, ...(maxLength ? { maxLength } : {}), ...(description ? { description } : {}) });
const env = (description = "Environment id") => str(ENV_PATTERN, description);

// ---------- widgets ----------

export const WIDGET_TYPES = ["env-status", "service-status", "metric-chart", "alarms", "map-neighbourhood", "pinned", "log-query", "costs", "activity", "approvals", "issues", "ci-failures", "text"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const WIDTHS = [3, 4, 6, 8, 12] as const;
export const HEIGHTS = [1, 2, 3] as const;
export type Width = (typeof WIDTHS)[number];
export type Height = (typeof HEIGHTS)[number];

export interface Widget {
  id: string;
  type: WidgetType;
  title?: string; // shown instead of the type's label
  config: Record<string, unknown>;
  w: Width; // columns of 12
  h: Height; // rows (one row ≈ 150 px)
}

export interface WidgetSpec {
  type: WidgetType;
  label: string;
  description: string;
  schema: JsonSchema; // the config; always { type: "object", additionalProperties: false }
  widths: readonly Width[];
  heights: readonly Height[];
  size: { w: Width; h: Height }; // when added
  defaults: Record<string, unknown>; // the add form starts here
  check?: (config: Record<string, unknown>) => string | undefined; // what the schema subset can't say
  needs?: Role; // the least role whose data it shows (the API refuses others, the UI says "needs <role>")
}

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const ALL_W: Width[] = [3, 4, 6, 8, 12];
const WIDE_W: Width[] = [4, 6, 8, 12];

export const WIDGETS: Record<WidgetType, WidgetSpec> = {
  "env-status": {
    type: "env-status", label: "Environment status", description: "Every environment's worst state and counts from the background sampler.",
    schema: obj({ envs: { type: "array", items: env(), maxItems: 20, description: "Only these environments (all when empty)" } }),
    widths: ALL_W, heights: [1, 2], size: { w: 12, h: 1 }, defaults: {},
  },
  "service-status": {
    type: "service-status", label: "Service status", description: "One ECS service: state, reasons, tasks and its CPU trend.",
    schema: obj({ env: env(), service: str(SERVICE_PATTERN, "Service id") }, ["env", "service"]),
    widths: [3, 4, 6], heights: [1, 2], size: { w: 4, h: 1 }, defaults: {},
  },
  "metric-chart": {
    type: "metric-chart", label: "Metric chart", description: "One CloudWatch metric of a service, host, database, cache or load balancer.",
    schema: obj(
      {
        env: env(),
        key: str(KEY_PATTERN, "Resource (overview key, e.g. service:api)"),
        metric: str(METRIC_PATTERN, "Metric id (cpu, mem, rps, p90…)"),
        minutes: { type: "integer", enum: [60, 360, 1440, 10080], default: 360, description: "Window" },
      },
      ["env", "key", "metric", "minutes"],
    ),
    widths: WIDE_W, heights: [1, 2, 3], size: { w: 6, h: 2 }, defaults: { metric: "cpu", minutes: 360 },
  },
  alarms: {
    type: "alarms", label: "CloudWatch alarms", description: "Alarms from the cloud map, those firing first.",
    schema: obj({ env: env("Only alarms placed in this environment"), region: str(REGION_PATTERN, "Only this region") }),
    widths: WIDE_W, heights: [1, 2, 3], size: { w: 4, h: 2 }, defaults: {},
  },
  "map-neighbourhood": {
    type: "map-neighbourhood", label: "Map neighbourhood", description: "A resource and what it connects to on the cloud map, one or two hops out.",
    schema: obj({ key: str(KEY_PATTERN, "Resource key (ARN or map key)"), hops: { type: "integer", enum: [1, 2], default: 1, description: "Hops" } }, ["key", "hops"]),
    widths: WIDE_W, heights: [2, 3], size: { w: 6, h: 2 }, defaults: { hops: 1 },
  },
  pinned: {
    type: "pinned", label: "Pinned resources", description: "Everything you starred, newest first.",
    schema: obj({}), widths: ALL_W, heights: [1, 2, 3], size: { w: 4, h: 2 }, defaults: {},
  },
  "log-query": {
    type: "log-query", label: "Log query", description: "A saved or inline log search: matches in the window and the newest lines.",
    schema: obj({
      savedId: str(ID_PATTERN, "Saved query"),
      env: env(),
      services: { type: "array", items: str(SERVICE_PATTERN), maxItems: 20, description: "Services (all with logs when empty)" },
      query: { type: "string", maxLength: 1024, pattern: ONE_LINE, description: "Text to find" },
      minutes: { type: "integer", enum: [15, 60, 360, 1440], default: 60, description: "Window" },
    }),
    check: (c) => {
      const saved = own(c, "savedId") !== undefined;
      const inline = ["env", "services", "query", "minutes"].some((k) => own(c, k) !== undefined);
      if (saved && inline) return "config: either savedId, or env + query (+ services, minutes) — not both";
      if (!saved && (own(c, "env") === undefined || own(c, "query") === undefined)) return "config: needs savedId, or env and query";
      return undefined;
    },
    widths: [6, 8, 12], heights: [2, 3], size: { w: 6, h: 2 }, defaults: { minutes: 60 },
  },
  costs: {
    type: "costs", label: "Costs", description: "Spend this month, the forecast and last month (Cost Explorer).",
    schema: obj({}), widths: [3, 4, 6], heights: [1, 2], size: { w: 4, h: 1 }, defaults: {}, needs: "operator",
  },
  activity: {
    type: "activity", label: "Activity", description: "Deploys, rollbacks, CI, ECS events and console actions, newest first.",
    schema: obj(
      {
        env: env("Only this environment (all when empty)"),
        kind: { type: "string", enum: ["deploys", "all"], default: "deploys", description: "Deploys and rollbacks only, or everything" },
        hours: { type: "integer", enum: [1, 6, 24, 168], default: 24, description: "Window" },
      },
      ["kind"],
    ),
    widths: WIDE_W, heights: [2, 3], size: { w: 6, h: 2 }, defaults: { kind: "deploys", hours: 24 },
  },
  approvals: {
    type: "approvals", label: "Approvals", description: "Agent requests waiting for a person.",
    schema: obj({ status: { type: "string", enum: ["pending"], default: "pending", description: "Status" } }),
    widths: WIDE_W, heights: [1, 2, 3], size: { w: 6, h: 1 }, defaults: { status: "pending" },
  },
  issues: {
    type: "issues", label: "Issues", description: "Everything down, degraded or unreadable right now.",
    schema: obj({}), widths: WIDE_W, heights: [1, 2, 3], size: { w: 6, h: 2 }, defaults: {},
  },
  "ci-failures": {
    type: "ci-failures", label: "CI failures", description: "Workflows whose latest run failed.",
    schema: obj({ repo: str(REPO_PATTERN, "Only this repository (owner/name)") }),
    widths: WIDE_W, heights: [1, 2, 3], size: { w: 6, h: 2 }, defaults: {},
  },
  text: {
    type: "text", label: "Text", description: "A note: plain text, with [links](https://…) and bare URLs.",
    schema: obj({ markdownLite: { type: "string", minLength: 1, maxLength: 4000, description: "Text" } }, ["markdownLite"]),
    widths: ALL_W, heights: [1, 2, 3], size: { w: 4, h: 1 }, defaults: { markdownLite: "" },
  },
};

export const isWidgetType = (v: unknown): v is WidgetType => typeof v === "string" && Object.hasOwn(WIDGETS, v);

// Problems with one widget's config (empty = valid): the schema, then the type's own rule.
export function widgetConfigProblems(type: WidgetType, config: unknown, path = "config"): string[] {
  const spec = WIDGETS[type];
  const out = validate(spec.schema, config).map((p) => (p.startsWith("input") ? `${path}${p.slice(5)}` : `${path}.${p}`));
  if (!out.length && spec.check) {
    const p = spec.check(config as Record<string, unknown>);
    if (p) out.push(p.replace(/^config/, path));
  }
  return out;
}

const WIDGET_FIELDS = ["id", "type", "title", "config", "w", "h"] as const;

export function widgetProblems(raw: unknown, path = "widget"): string[] {
  if (!isObj(raw)) return [`${path}: must be an object`];
  const out = unknownFields(raw, WIDGET_FIELDS, `${path}.`);
  const id = own(raw, "id");
  if (!isWorkspaceId(id)) out.push(`${path}.id: letters, digits, - and _ (1–64)`);
  const type = own(raw, "type");
  if (!isWidgetType(type)) return [...out, `${path}.type: must be one of ${WIDGET_TYPES.join(", ")}`];
  const spec = WIDGETS[type];
  const title = own(raw, "title");
  if (title !== undefined && (typeof title !== "string" || title.length > WORKSPACE_LIMITS.titleChars || !NO_CONTROL.test(title)))
    out.push(`${path}.title: text of at most ${WORKSPACE_LIMITS.titleChars} characters`);
  const config = own(raw, "config") ?? {};
  out.push(...widgetConfigProblems(type, config, `${path}.config`));
  const w = own(raw, "w");
  const h = own(raw, "h");
  if (!spec.widths.includes(w as Width)) out.push(`${path}.w: ${spec.label} is ${spec.widths.join(", ")} columns wide`);
  if (!spec.heights.includes(h as Height)) out.push(`${path}.h: ${spec.label} is ${spec.heights.join(", ")} rows tall`);
  return out;
}

// The widget as stored and served: own fields only, title trimmed away when empty.
function cleanWidget(raw: Record<string, unknown>): Widget {
  const type = raw.type as WidgetType;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const config = isObj(raw.config) ? Object.fromEntries(Object.entries(raw.config).filter(([, v]) => v !== undefined)) : {};
  return { id: raw.id as string, type, ...(title ? { title } : {}), config, w: raw.w as Width, h: raw.h as Height };
}

// ---------- dashboards ----------

export const VISIBILITIES = ["private", "team"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const isVisibility = (v: unknown): v is Visibility => v === "private" || v === "team";

export interface DashboardDoc {
  name: string;
  description?: string;
  visibility: Visibility;
  minRole: Role; // team dashboards: the least role that sees it ("viewer" = everyone signed in)
  widgets: Widget[];
}

// What GET /api/dashboards/[id] returns.
export interface Dashboard extends DashboardDoc {
  id: string;
  owner: { id: string; email?: string };
  template?: string;
  version: number; // optimistic concurrency: PATCH sends the version it edited
  createdAt: number;
  updatedAt: number;
  mine: boolean;
  canEdit: boolean;
}

// What GET /api/dashboards lists (no widget configs).
export type DashboardSummary = Omit<Dashboard, "widgets"> & { widgetCount: number; types: WidgetType[] };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; problems: string[] };
const fail = <T>(problems: string[]): Parsed<T> => ({ ok: false, error: problems.length > 1 ? `${problems[0]} (and ${problems.length - 1} more)` : (problems[0] ?? "invalid"), problems });

function nameProblem(v: unknown, field = "name"): string | undefined {
  if (typeof v !== "string" || !v.trim()) return `${field}: required`;
  if (v.trim().length > WORKSPACE_LIMITS.nameChars) return `${field}: at most ${WORKSPACE_LIMITS.nameChars} characters`;
  if (!NO_CONTROL.test(v)) return `${field}: one line of text`;
  return undefined;
}

function descriptionProblem(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > WORKSPACE_LIMITS.descriptionChars) return `description: text of at most ${WORKSPACE_LIMITS.descriptionChars} characters`;
  return undefined;
}

// A whole dashboard document: own properties only, ≤ 24 widgets with unique ids, name ≤ 80, ≤ 64 KB as JSON.
export function validateDashboard(raw: unknown): Parsed<DashboardDoc> {
  if (!isObj(raw)) return fail(["body: must be an object"]);
  const problems = unknownFields(raw, ["name", "description", "visibility", "minRole", "widgets"]);
  const name = own(raw, "name");
  const description = own(raw, "description");
  const visibility = own(raw, "visibility") ?? "private";
  const minRole = own(raw, "minRole") ?? "viewer";
  const widgets = own(raw, "widgets") ?? [];
  const np = nameProblem(name);
  if (np) problems.push(np);
  const dp = descriptionProblem(description);
  if (dp) problems.push(dp);
  if (!isVisibility(visibility)) problems.push("visibility: private or team");
  if (!isRole(minRole)) problems.push(`minRole: one of ${ROLES.join(", ")}`);
  if (!Array.isArray(widgets)) problems.push("widgets: must be a list");
  else {
    if (widgets.length > WORKSPACE_LIMITS.widgets) problems.push(`widgets: at most ${WORKSPACE_LIMITS.widgets}`);
    const seen = new Set<string>();
    widgets.slice(0, WORKSPACE_LIMITS.widgets).forEach((w, i) => {
      problems.push(...widgetProblems(w, `widgets[${i}]`));
      const id = isObj(w) ? own(w, "id") : undefined;
      if (typeof id === "string") {
        if (seen.has(id)) problems.push(`widgets[${i}].id: "${id}" is used twice`);
        seen.add(id);
      }
    });
  }
  if (problems.length) return fail(problems);
  const doc: DashboardDoc = {
    name: (name as string).trim(),
    ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}),
    visibility: visibility as Visibility,
    minRole: minRole as Role,
    widgets: (widgets as Record<string, unknown>[]).map(cleanWidget),
  };
  const size = bytes(JSON.stringify({ name: doc.name, description: doc.description, widgets: doc.widgets }));
  if (size > WORKSPACE_LIMITS.payloadBytes) return fail([`dashboard: ${Math.ceil(size / 1024)} KB as JSON — at most ${WORKSPACE_LIMITS.payloadBytes / 1024} KB`]);
  return { ok: true, value: doc };
}

export const TEMPLATE_IDS = ["team-overview", "incident"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const isTemplateId = (v: unknown): v is TemplateId => typeof v === "string" && (TEMPLATE_IDS as readonly string[]).includes(v);

export interface DashboardCreate extends DashboardDoc {
  template?: TemplateId;
}

// POST /api/dashboards: { name, description?, visibility?, minRole?, template?, widgets? }. A template without widgets
// starts from the template's own (the Incident template's live charts need the current issues: the UI sends them).
export function parseDashboardCreate(raw: unknown): Parsed<DashboardCreate> {
  if (!isObj(raw)) return fail(["body: must be an object"]);
  const extra = unknownFields(raw, ["name", "description", "visibility", "minRole", "widgets", "template"]);
  const template = own(raw, "template");
  if (template !== undefined && template !== null && !isTemplateId(template)) extra.push(`template: one of ${TEMPLATE_IDS.join(", ")}`);
  if (extra.length) return fail(extra);
  const t = isTemplateId(template) ? template : undefined;
  const widgets = own(raw, "widgets") ?? (t ? templateDoc(t).widgets : []);
  const v = validateDashboard({ ...pick(raw, ["name", "description", "visibility", "minRole"]), widgets });
  return v.ok ? { ok: true, value: { ...v.value, ...(t ? { template: t } : {}) } } : v;
}

export interface DashboardPatch {
  version: number;
  name?: string;
  description?: string | null; // null or "" clears it
  visibility?: Visibility;
  minRole?: Role;
  widgets?: Widget[];
}

// PATCH /api/dashboards/[id]: { version, …fields to change }. Checked again as a whole once merged (applyPatch).
export function parseDashboardPatch(raw: unknown): Parsed<DashboardPatch> {
  if (!isObj(raw)) return fail(["body: must be an object"]);
  const problems = unknownFields(raw, ["version", "name", "description", "visibility", "minRole", "widgets"]);
  const version = own(raw, "version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) problems.push("version: required — the version you edited (an integer ≥ 1)");
  if (problems.length) return fail(problems);
  const out: DashboardPatch = { version: version as number };
  for (const k of ["name", "visibility", "minRole", "widgets"] as const) if (own(raw, k) !== undefined) (out as unknown as Record<string, unknown>)[k] = own(raw, k);
  if (Object.hasOwn(raw, "description")) out.description = (own(raw, "description") as string | null) ?? null;
  return { ok: true, value: out };
}

// The document after a patch, validated whole (a patch alone can't break a rule the merged result would).
export function applyPatch(cur: DashboardDoc, p: DashboardPatch): Parsed<DashboardDoc> {
  const description = p.description === undefined ? cur.description : p.description === null || p.description === "" ? undefined : p.description;
  return validateDashboard({
    name: p.name ?? cur.name,
    ...(description !== undefined ? { description } : {}),
    visibility: p.visibility ?? cur.visibility,
    minRole: p.minRole ?? cur.minRole,
    widgets: p.widgets ?? cur.widgets,
  });
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(o, k) && o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

// The nearest allowed size for a type (a stored layout from an older catalogue, a hand-written body).
export function snapSize(type: WidgetType, w: unknown, h: unknown): { w: Width; h: Height } {
  const spec = WIDGETS[type];
  const near = <T extends number>(list: readonly T[], v: unknown, dflt: T): T =>
    typeof v === "number" && Number.isFinite(v) ? list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), list[0]) : dflt;
  return { w: near(spec.widths, w, spec.size.w), h: near(spec.heights, h, spec.size.h) };
}

// Stored rows keep the widgets ([{id, type, title?, config}]) and the layout ({cols: 12, items: [{id, w, h}]}, the
// order) apart. Reading them back is tolerant: unknown types and duplicate ids are dropped, sizes snap to the type's,
// widgets missing from the layout follow it in stored order, layout items without a widget are ignored, at most 24.
export function normaliseLayout(widgets: unknown, layout: unknown): Widget[] {
  const list = Array.isArray(widgets) ? widgets : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const w of list) {
    if (!isObj(w) || !isWorkspaceId(own(w, "id")) || !isWidgetType(own(w, "type")) || byId.has(w.id as string)) continue;
    byId.set(w.id as string, w);
  }
  const items = isObj(layout) && Array.isArray(layout.items) ? layout.items.filter(isObj) : [];
  const order: { id: string; w?: unknown; h?: unknown }[] = [];
  const placed = new Set<string>();
  for (const it of items) {
    const id = own(it, "id");
    if (typeof id !== "string" || !byId.has(id) || placed.has(id)) continue;
    placed.add(id);
    order.push({ id, w: own(it, "w"), h: own(it, "h") });
  }
  for (const id of byId.keys()) if (!placed.has(id)) order.push({ id, w: own(byId.get(id)!, "w"), h: own(byId.get(id)!, "h") });
  return order.slice(0, WORKSPACE_LIMITS.widgets).map(({ id, w, h }) => {
    const raw = byId.get(id)!;
    const type = raw.type as WidgetType;
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, WORKSPACE_LIMITS.titleChars) : undefined;
    return { id, type, ...(title ? { title } : {}), config: isObj(raw.config) ? raw.config : {}, ...snapSize(type, w, h) };
  });
}

// The two stored columns for a list of widgets (the inverse of normaliseLayout).
export function storeLayout(widgets: Widget[]): { widgets: Omit<Widget, "w" | "h">[]; layout: { cols: 12; items: { id: string; w: Width; h: Height }[] } } {
  return {
    widgets: widgets.map(({ id, type, title, config }) => ({ id, type, ...(title ? { title } : {}), config })),
    layout: { cols: 12, items: widgets.map(({ id, w, h }) => ({ id, w, h })) },
  };
}

// A widget id not yet on the dashboard: "<type>-<n>".
export function newWidgetId(type: WidgetType, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`${type}-${n}`)) return `${type}-${n}`;
}

// A widget of a type with its default size and config.
export function makeWidget(type: WidgetType, taken: Iterable<string>, config: Record<string, unknown> = {}, size?: { w: Width; h: Height }): Widget {
  const spec = WIDGETS[type];
  return { id: newWidgetId(type, taken), type, config: { ...spec.defaults, ...config }, ...(size ? snapSize(type, size.w, size.h) : spec.size) };
}

// Move one widget up (-1) or down (+1); out of range is a no-op.
export function moveWidget(list: Widget[], id: string, by: -1 | 1): Widget[] {
  const i = list.findIndex((w) => w.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---------- who may see and change what ----------

export const roleRank = (r: Role) => ROLES.indexOf(r);
export const atLeast = (role: Role, min: Role) => roleRank(role) >= roleRank(min);

interface Viewer {
  id: string;
  role: Role;
}
interface Shared {
  ownerId: string;
  visibility: Visibility;
  minRole?: Role | null;
}

// The owner, or — for a team dashboard — anyone signed in whose role is at least minRole.
export function canView(user: Viewer, d: Shared): boolean {
  if (d.ownerId === user.id) return true;
  return d.visibility === "team" && atLeast(user.role, isRole(d.minRole) ? d.minRole : "viewer");
}

// The owner, or an admin for a dashboard shared with the team (a private one stays the owner's alone).
export function canEdit(user: Viewer, d: Shared): boolean {
  if (d.ownerId === user.id) return true;
  return user.role === "admin" && canView(user, d);
}

// ---------- templates ----------

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  description: string;
  widgets: Widget[];
}

// What the Incident template needs from /api/issues to add its live charts.
export interface IssueLike {
  env: string;
  key: string;
  kind: string;
  name?: string;
  state: string;
}

const W = (id: string, type: WidgetType, w: Width, h: Height, config: Record<string, unknown> = {}, title?: string): Widget => ({ id, type, ...(title ? { title } : {}), config, w, h });

// Unhealthy ECS services (down or degraded), worst first, at most `max` — the Incident template charts each one.
export function unhealthyServices(issues: IssueLike[], max: number = WORKSPACE_LIMITS.incidentCharts): IssueLike[] {
  const rank = (s: string) => (s === "DOWN" ? 0 : 1);
  return issues
    .filter((i) => i.kind === "service" && (i.state === "DOWN" || i.state === "DEGRADED") && isEnvId(i.env) && typeof i.key === "string" && i.key.startsWith("service:"))
    .sort((a, b) => rank(a.state) - rank(b.state) || (a.env + a.key).localeCompare(b.env + b.key))
    .slice(0, max);
}

// The Incident board: issues, alarms, CI failures, deploys and rollbacks in the last 6 hours, a CPU chart per
// unhealthy service (live, from the issues passed in), approvals.
export function incidentWidgets(issues: IssueLike[] = []): Widget[] {
  const sick = unhealthyServices(issues);
  // Two charts a row; an odd last one takes the whole row.
  const charts = sick.map((i, n) => W(`metric-chart-${n + 1}`, "metric-chart", n === sick.length - 1 && sick.length % 2 ? 12 : 6, 2, { env: i.env, key: i.key, metric: "cpu", minutes: 360 }, `${i.name ?? i.key.slice(8)} · CPU (${i.env})`));
  return [
    W("issues-1", "issues", 8, 2),
    W("alarms-1", "alarms", 4, 2),
    W("ci-failures-1", "ci-failures", 6, 2),
    W("activity-1", "activity", 6, 2, { kind: "deploys", hours: 6 }),
    ...charts,
    W("approvals-1", "approvals", 12, 1, { status: "pending" }),
  ];
}

export function templateDoc(id: TemplateId, issues: IssueLike[] = []): TemplateInfo {
  if (id === "incident") {
    return { id, name: "Incident", description: "Issues, firing alarms, failing CI, recent deploys and rollbacks, a chart per unhealthy service and pending approvals.", widgets: incidentWidgets(issues) };
  }
  return {
    id,
    name: "Team overview",
    description: "Every environment's state, open issues, pending approvals, recent deploys and spend.",
    widgets: [W("env-status-1", "env-status", 12, 1), W("issues-1", "issues", 6, 2), W("approvals-1", "approvals", 6, 2, { status: "pending" }), W("activity-1", "activity", 8, 2, { kind: "deploys", hours: 24 }), W("costs-1", "costs", 4, 2)],
  };
}

export const TEMPLATES: TemplateInfo[] = TEMPLATE_IDS.map((id) => templateDoc(id));

// ---------- home page ----------

export const PREF_KEYS = ["home", "region", "dashboards.lastOpened"] as const;
export type PrefKey = (typeof PREF_KEYS)[number];
export type Prefs = Partial<Record<PrefKey, string>>;
export const isPrefKey = (k: unknown): k is PrefKey => typeof k === "string" && (PREF_KEYS as readonly string[]).includes(k);

export type HomeTarget = { kind: "overview" } | { kind: "incident" } | { kind: "dashboard"; id: string };

// "overview" | "incident" | "dashboard:<id>"; anything else (or nothing) is the Overview.
export function homeTarget(v: unknown): HomeTarget {
  if (v === "incident") return { kind: "incident" };
  if (typeof v === "string" && v.startsWith("dashboard:") && isWorkspaceId(v.slice(10))) return { kind: "dashboard", id: v.slice(10) };
  return { kind: "overview" };
}

// A link into the Overview — a resource panel (?r=), an environment (?env=, e.g. an issues row for an env that isn't
// sampled) or ?view=overview — opens the Overview whatever the person's home page is.
export const overviewLink = (sp: { has(k: string): boolean; get(k: string): string | null }) => sp.has("r") || sp.has("env") || sp.get("view") === "overview";

// PATCH /api/me/prefs: allow-listed keys only; null (or "") removes one.
export function parsePrefsPatch(raw: unknown): Parsed<Partial<Record<PrefKey, string | null>>> {
  if (!isObj(raw)) return fail(["body: must be an object"]);
  const problems = Object.keys(raw).filter((k) => !isPrefKey(k)).map((k) => `${k}: not a preference (allowed: ${PREF_KEYS.join(", ")})`);
  const out: Partial<Record<PrefKey, string | null>> = {};
  for (const k of PREF_KEYS) {
    if (!Object.hasOwn(raw, k)) continue;
    const v = raw[k];
    if (v === null || v === "") {
      out[k] = null;
      continue;
    }
    if (k === "home" && !(v === "overview" || v === "incident" || (typeof v === "string" && homeTarget(v).kind === "dashboard"))) problems.push('home: "overview", "incident" or "dashboard:<id>"');
    else if (k === "region" && !(v === "all" || isRegionCode(v))) problems.push('region: "all" or a region code');
    else if (k === "dashboards.lastOpened" && !isWorkspaceId(v)) problems.push("dashboards.lastOpened: a dashboard id");
    else out[k] = v as string;
  }
  return problems.length ? fail(problems) : { ok: true, value: out };
}

// ---------- pins ----------

export interface Pin {
  rkey: string;
  name: string;
  kind: string;
  env?: string;
  region?: string;
  createdAt: number;
}

const reKey = new RegExp(KEY_PATTERN);
const reKind = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,59}$/;

// POST /api/pins: { rkey, name, kind, env?, region? } — the shape <PinButton> sends.
export function parsePin(raw: unknown): Parsed<Omit<Pin, "createdAt">> {
  if (!isObj(raw)) return fail(["body: must be an object"]);
  const problems = unknownFields(raw, ["rkey", "name", "kind", "env", "region"]);
  const rkey = own(raw, "rkey");
  const name = own(raw, "name");
  const kind = own(raw, "kind");
  const e = own(raw, "env");
  const region = own(raw, "region");
  if (typeof rkey !== "string" || !reKey.test(rkey)) problems.push("rkey: a resource key (1–512 characters)");
  if (typeof name !== "string" || !name.trim() || name.length > 200 || !NO_CONTROL.test(name)) problems.push("name: one line, 1–200 characters");
  if (typeof kind !== "string" || !reKind.test(kind)) problems.push("kind: a resource kind");
  if (e !== undefined && e !== null && !isEnvId(e)) problems.push("env: an environment id");
  if (region !== undefined && region !== null && !(region === "global" || isRegionCode(region))) problems.push("region: a region code");
  if (problems.length) return fail(problems);
  return { ok: true, value: { rkey: rkey as string, name: (name as string).trim(), kind: kind as string, ...(isEnvId(e) ? { env: e } : {}), ...(typeof region === "string" ? { region } : {}) } };
}

// Where a pin opens: ECS resources pinned from the overview open their panel there, everything else on the map.
const OVERVIEW_KEY = /^(service|box|database|cache|loadbalancer|external):/;
export function pinHref(p: Pick<Pin, "rkey" | "env">): string {
  if (p.env && OVERVIEW_KEY.test(p.rkey)) return `/?env=${encodeURIComponent(p.env)}&r=${encodeURIComponent(p.rkey)}`;
  return `/map?r=${encodeURIComponent(p.rkey)}`;
}

// ---------- saved views and log queries ----------

export const SAVED_KINDS = ["view", "log-query"] as const;
export type SavedKind = (typeof SAVED_KINDS)[number];
export const isSavedKind = (v: unknown): v is SavedKind => v === "view" || v === "log-query";

export interface ViewPayload {
  path: string; // "/logs"
  search: string; // "?env=staging&service=api" or ""
  title?: string;
}
export interface LogQueryPayload {
  env?: string;
  services?: string[];
  query: string;
  minutes: number;
}
export type SavedPayload = ViewPayload | LogQueryPayload;

export interface SavedItem {
  id: string;
  kind: SavedKind;
  name: string;
  payload: SavedPayload;
  visibility: Visibility;
  owner: { id: string; email?: string };
  mine: boolean;
  canEdit: boolean;
  createdAt: number;
  updatedAt: number;
}

// A same-origin path: "/x", never "//host" or "/\host" (a browser reads both as another site).
const SAFE_PATH = /^\/(?![/\\])[^\s\\]*$/;
const reService = new RegExp(SERVICE_PATTERN);

export function payloadProblems(kind: SavedKind, raw: unknown): string[] {
  if (!isObj(raw)) return ["payload: must be an object"];
  if (bytes(JSON.stringify(raw)) > WORKSPACE_LIMITS.savedPayloadBytes) return [`payload: at most ${WORKSPACE_LIMITS.savedPayloadBytes / 1024} KB`];
  if (kind === "view") {
    const out = unknownFields(raw, ["path", "search", "title"], "payload.");
    const path = own(raw, "path");
    const search = own(raw, "search") ?? "";
    const title = own(raw, "title");
    if (typeof path !== "string" || path.length > 300 || !SAFE_PATH.test(path) || path.startsWith("/api/")) out.push("payload.path: a console page path such as /logs");
    if (typeof search !== "string" || search.length > 2000 || (search !== "" && !search.startsWith("?")) || !NO_CONTROL.test(search)) out.push('payload.search: "" or a query string starting with ?');
    if (title !== undefined && (typeof title !== "string" || title.length > 120 || !NO_CONTROL.test(title))) out.push("payload.title: at most 120 characters");
    return out;
  }
  const out = unknownFields(raw, ["env", "services", "query", "minutes"], "payload.");
  const e = own(raw, "env");
  const services = own(raw, "services");
  const query = own(raw, "query");
  const minutes = own(raw, "minutes");
  if (e !== undefined && e !== null && e !== "" && !isEnvId(e)) out.push("payload.env: an environment id"); // "" / null: none
  if (services !== undefined && (!Array.isArray(services) || services.length > 20 || !services.every((s) => typeof s === "string" && reService.test(s)))) out.push("payload.services: up to 20 service ids");
  if (typeof query !== "string" || query.length > 1024 || /[\r\n]/.test(query)) out.push("payload.query: one line, at most 1024 characters");
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 10080) out.push("payload.minutes: whole minutes, 1–10080");
  return out;
}

function cleanPayload(kind: SavedKind, raw: Record<string, unknown>): SavedPayload {
  if (kind === "view") return { path: raw.path as string, search: (own(raw, "search") as string | undefined) ?? "", ...(typeof raw.title === "string" && raw.title ? { title: raw.title } : {}) };
  const services = own(raw, "services") as string[] | undefined;
  return { ...(isEnvId(own(raw, "env")) ? { env: raw.env as string } : {}), ...(services?.length ? { services: [...new Set(services)] } : {}), query: raw.query as string, minutes: raw.minutes as number };
}

export interface SavedInput {
  kind: SavedKind;
  name: string;
  payload: SavedPayload;
  visibility: Visibility;
}

// POST /api/saved: { kind, name, payload, visibility? }.
export function parseSavedInput(raw: unknown): Parsed<SavedInput> {
  if (!isObj(raw)) return fail(["body: must be an object"]);
  const problems = unknownFields(raw, ["kind", "name", "payload", "visibility"]);
  const kind = own(raw, "kind");
  const visibility = own(raw, "visibility") ?? "private";
  if (!isSavedKind(kind)) return fail([...problems, "kind: view or log-query"]);
  const np = nameProblem(own(raw, "name"));
  if (np) problems.push(np);
  if (!isVisibility(visibility)) problems.push("visibility: private or team");
  const payload = own(raw, "payload");
  problems.push(...payloadProblems(kind, payload));
  if (problems.length) return fail(problems);
  return { ok: true, value: { kind, name: (own(raw, "name") as string).trim(), payload: cleanPayload(kind, payload as Record<string, unknown>), visibility: visibility as Visibility } };
}

export interface SavedPatch {
  name?: string;
  payload?: SavedPayload;
  visibility?: Visibility;
}

// PATCH /api/saved/[id]: { name?, payload?, visibility? } (the kind never changes).
export function parseSavedPatch(kind: SavedKind, raw: unknown): Parsed<SavedPatch> {
  if (!isObj(raw)) return fail(["body: must be an object"]);
  const problems = unknownFields(raw, ["name", "payload", "visibility"]);
  const out: SavedPatch = {};
  const name = own(raw, "name");
  if (name !== undefined) {
    const np = nameProblem(name);
    if (np) problems.push(np);
    else out.name = (name as string).trim();
  }
  const visibility = own(raw, "visibility");
  if (visibility !== undefined) {
    if (!isVisibility(visibility)) problems.push("visibility: private or team");
    else out.visibility = visibility;
  }
  const payload = own(raw, "payload");
  if (payload !== undefined) {
    const pp = payloadProblems(kind, payload);
    if (pp.length) problems.push(...pp);
    else out.payload = cleanPayload(kind, payload as Record<string, unknown>);
  }
  if (problems.length) return fail(problems);
  return { ok: true, value: out };
}

// A saved item is the owner's; one shared with the team may also be changed or deleted by an admin.
export const canEditSaved = (user: Viewer, item: { ownerId: string; visibility: Visibility }) => item.ownerId === user.id || (user.role === "admin" && item.visibility === "team");
export const canViewSaved = (user: Viewer, item: { ownerId: string; visibility: Visibility }) => item.ownerId === user.id || item.visibility === "team";

// Where a saved view opens; where a saved (or inline) log query opens on /logs (it reads env, service, q, minutes).
export const viewHref = (p: ViewPayload) => `${p.path}${p.search ?? ""}`;
export function logsHref(q: { env?: string; services?: string[]; query: string; minutes?: number }): string {
  const s = new URLSearchParams();
  if (q.env) s.set("env", q.env);
  if (q.services?.length) s.set("service", q.services.join(","));
  if (q.query) s.set("q", q.query);
  if (q.minutes) s.set("minutes", String(q.minutes));
  const t = s.toString();
  return `/logs${t ? `?${t}` : ""}`;
}

// ---------- widget helpers (pure parts of the widgets in src/components/dashboards/) ----------

// The text widget: plain text, with [label](href) links and bare http(s) URLs. Links are http(s) or a console path;
// anything else (javascript:, data:, //host) stays text.
export type TextSegment = { text: string; href?: string };
const LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)|(https?:\/\/[^\s<>()]{1,2000})/g;
export function safeHref(href: string): string | undefined {
  if (SAFE_PATH.test(href)) return href;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? href : undefined;
  } catch {
    return undefined;
  }
}
export function textSegments(text: string): TextSegment[][] {
  return text.split(/\r?\n/).map((line) => {
    const out: TextSegment[] = [];
    let last = 0;
    for (const m of line.matchAll(LINK)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ text: line.slice(last, at) });
      // A bare URL doesn't end in sentence punctuation ("see https://x.example." links https://x.example).
      const bare = m[3]?.replace(/[.,;:!?'"]+$/, "");
      const href = safeHref(m[2] ?? bare!);
      out.push(href ? { text: m[1] ?? bare!, href } : { text: m[1] !== undefined ? m[0] : bare! });
      last = at + (m[1] !== undefined ? m[0].length : bare!.length);
    }
    if (last < line.length || !out.length) out.push({ text: line.slice(last) });
    return out;
  });
}

// The map neighbourhood: the resource, and every resource within `hops` edges of it (either direction), nearest first.
export interface EdgeLike {
  from: string;
  to: string;
  kind: string;
  label?: string;
}
export function neighbourhood(edges: EdgeLike[], key: string, hops: number, max = 40): { nodes: { key: string; depth: number; via?: string }[]; edges: EdgeLike[] } {
  const depth = new Map<string, number>([[key, 0]]);
  const via = new Map<string, string>();
  let frontier = [key];
  for (let d = 1; d <= Math.max(1, Math.min(hops, 2)) && frontier.length; d++) {
    const next: string[] = [];
    const here = new Set(frontier);
    for (const e of edges) {
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) {
        if (!here.has(a) || depth.has(b) || depth.size >= max) continue;
        depth.set(b, d);
        via.set(b, e.label ? `${e.kind} · ${e.label}` : e.kind);
        next.push(b);
      }
    }
    frontier = next;
  }
  const nodes = [...depth].map(([k, d]) => ({ key: k, depth: d, ...(via.has(k) ? { via: via.get(k)! } : {}) })).sort((a, b) => a.depth - b.depth);
  return { nodes, edges: edges.filter((e) => depth.has(e.from) && depth.has(e.to) && e.from !== e.to) };
}

// CI failures: per (repo, workflow, branch) the latest run, kept when it failed — a workflow that failed and then
// passed is fixed. Newest first.
export interface CiRunLike {
  id: number | string;
  repo: string;
  workflow: string;
  branch: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
export function currentFailures<R extends CiRunLike>(runs: R[], now: number = Date.now(), maxAgeMs = 7 * 86_400_000): R[] {
  const latest = new Map<string, R>();
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const k = `${r.repo}\u0000${r.workflow}\u0000${r.branch}`;
    const cur = latest.get(k);
    if (!cur || Date.parse(r.createdAt) > Date.parse(cur.createdAt)) latest.set(k, r);
  }
  return [...latest.values()]
    .filter((r) => FAILED.has(r.conclusion ?? "") && now - Date.parse(r.createdAt) <= maxAgeMs)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// Activity: deploys and rollbacks (a deploy run, a console revision switch or rollback, an ECS rollout completing
// or rolling back). ECS counts on its own: a service deployed without GitHub connected still shows its deploys.
export interface ActivityLike {
  at: number;
  kind: string;
  title: string;
  detail?: string;
}
export function isDeployOrRollback(i: ActivityLike): boolean {
  if (i.kind === "deploy") return true;
  const text = `${i.title} ${i.detail ?? ""}`;
  if (i.kind === "action") return /\b(switch|rollback|roll back|revision|deploy)/i.test(text);
  if (i.kind === "ecs") return /deployment completed|roll(ing|ed)? back|rollback/i.test(text);
  return false;
}
export function filterActivity<T extends ActivityLike>(items: T[], o: { kind?: unknown; hours?: unknown }, now: number = Date.now()): T[] {
  const hours = typeof o.hours === "number" && o.hours > 0 ? o.hours : 24;
  return items.filter((i) => now - i.at <= hours * 3_600_000 && (o.kind !== "deploys" || isDeployOrRollback(i))).sort((a, b) => b.at - a.at);
}

// "your role (viewer) can't do this — needs operator" → "operator" (the widget says "needs operator").
export function neededRole(message: string | undefined): Role | undefined {
  const m = /needs (?:the )?(viewer|developer|operator|admin)\b/i.exec(message ?? "");
  return m ? (m[1].toLowerCase() as Role) : undefined;
}

// The global region filter: "all", or one region (a global resource or one with no region always matches).
export const regionMatches = (filter: string, region: string | undefined) => filter === "all" || !region || region === "global" || region === filter;

// R21: a widget's freshness, from its own data — the API's `freshness` when it sends one, else when the widget last
// loaded it. A failed refresh keeps the data on screen and says so. undefined until anything loaded.
export function widgetFreshness(o: { at?: number; server?: Freshness; error?: string; failedAt?: number; staleAfterMs: number; source: string }): Freshness | undefined {
  if (!o.at && !o.server) return undefined;
  const base: Freshness = o.server ?? { observedAt: o.at, staleAfterMs: o.staleAfterMs, source: o.source, completeness: "complete" };
  return o.error ? { ...base, error: o.error, ...(o.failedAt ? { refreshFailedAt: o.failedAt } : {}) } : base;
}

// Freshness of sampler-backed rows (/api/envs): as old as the oldest sample; an environment the sampler hasn't read
// lately makes the view partial and is named.
export function sampledFreshness(items: { id: string; sampledAt?: number; stale?: boolean }[], staleAfterMs: number): Freshness | undefined {
  if (!items.length) return undefined;
  const known = items.map((i) => i.sampledAt).filter((n): n is number => typeof n === "number" && n > 0);
  const stale = items.filter((i) => i.stale).map((i) => i.id);
  return {
    ...(known.length === items.length ? { observedAt: Math.min(...known) } : {}),
    staleAfterMs,
    source: "sampler",
    completeness: stale.length ? "partial" : "complete",
    ...(stale.length ? { notes: stale.map((id) => `${id} not sampled recently`) } : {}),
  };
}
