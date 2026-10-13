// Integration rows and delivery records in the console DB (integration changes and tickets are audited through mutate()).
// One row per plugin id: `config` is JSON with every secret field sealed; `events` is the notify subscription.
import "server-only";
import { open, redact, type Stored } from "../../plugins/config.ts";
import { DEFAULT_SUBSCRIPTION, parseSubscription, type Subscription } from "../../plugins/events.ts";
import type { Config, Field, IntegrationView, Plugin } from "../../plugins/types.ts";
import { getDb, newId } from "../db.ts";
import { unseal } from "../secrets.ts";

export interface Integration {
  id: string;
  enabled: boolean;
  stored: Stored;
  subscription: Subscription;
  updatedAt?: number;
  updatedBy?: string;
}

type Row = { id: string; enabled: number; config: string | null; events: string | null; updated_at: number | null; updated_by: string | null };

function parseJson(s: string | null): unknown {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

const fromRow = (r: Row): Integration => {
  const cfg = parseJson(r.config);
  return {
    id: r.id,
    enabled: Number(r.enabled) === 1,
    stored: cfg && typeof cfg === "object" ? (cfg as Stored) : {},
    subscription: r.events ? parseSubscription(parseJson(r.events)) : DEFAULT_SUBSCRIPTION,
    updatedAt: r.updated_at ?? undefined,
    updatedBy: r.updated_by ?? undefined,
  };
};

export async function readAll(): Promise<Map<string, Integration>> {
  const rows = await (await getDb()).all<Row>("SELECT id, enabled, config, events, updated_at, updated_by FROM integrations");
  return new Map(rows.map((r) => [r.id, fromRow(r)]));
}

export async function readOne(id: string): Promise<Integration | undefined> {
  const r = await (await getDb()).get<Row>("SELECT id, enabled, config, events, updated_at, updated_by FROM integrations WHERE id = ?", [id]);
  return r ? fromRow(r) : undefined;
}

export async function save(i: Omit<Integration, "updatedAt">, by: string) {
  await (await getDb()).run(
    `INSERT INTO integrations (id, enabled, config, events, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, events = excluded.events,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [i.id, i.enabled ? 1 : 0, JSON.stringify(i.stored), JSON.stringify(i.subscription), Date.now(), by],
  );
}

export async function remove(id: string) {
  await (await getDb()).run("DELETE FROM integrations WHERE id = ?", [id]);
}

// Plain values for the plugin. Only ever held server-side.
export const configOf = (fields: Field[], stored: Stored): Config => open(fields, stored, unseal);

// ---------- deliveries ----------

export interface Delivery {
  id: string;
  integration: string;
  event: string;
  at: number;
  ok: boolean;
  detail: string;
}

export async function recordDelivery(integration: string, event: string, ok: boolean, detail: string) {
  await (await getDb()).run("INSERT INTO deliveries (id, integration, event, at, ok, detail) VALUES (?, ?, ?, ?, ?, ?)", [newId(), integration, event, Date.now(), ok ? 1 : 0, detail.slice(0, 500)]);
}

export async function recentDeliveries(limit = 50): Promise<Delivery[]> {
  const rows = await (await getDb()).all<Omit<Delivery, "ok"> & { ok: number }>("SELECT id, integration, event, at, ok, detail FROM deliveries ORDER BY at DESC LIMIT ?", [limit]);
  return rows.map((r) => ({ ...r, at: Number(r.at), ok: Number(r.ok) === 1 }));
}

export async function lastDeliveries(): Promise<Map<string, { ok: boolean; at: number }>> {
  const rows = await (await getDb()).all<{ integration: string; ok: number; at: number }>(
    `SELECT d.integration, d.ok, d.at FROM deliveries d
     JOIN (SELECT integration, MAX(at) AS m FROM deliveries GROUP BY integration) x ON x.integration = d.integration AND x.m = d.at`,
  );
  return new Map(rows.map((r) => [r.integration, { ok: Number(r.ok) === 1, at: Number(r.at) }]));
}

export async function pruneDeliveries(olderThanMs: number) {
  return (await getDb()).run("DELETE FROM deliveries WHERE at < ?", [Date.now() - olderThanMs]);
}

// ---------- API view ----------

export function viewOf(p: Plugin, i: Integration | undefined, admin: boolean, last?: { ok: boolean; at: number }): IntegrationView {
  const v: IntegrationView = {
    id: p.id, name: p.name, description: p.description, icon: p.icon, docsUrl: p.docsUrl, capabilities: p.capabilities, fields: p.fields,
    configured: !!i, enabled: !!i?.enabled, lastDelivery: last,
  };
  if (admin) {
    v.config = i ? redact(p.fields, i.stored) : {};
    v.events = i?.subscription ?? DEFAULT_SUBSCRIPTION;
    v.updatedAt = i?.updatedAt;
    v.updatedBy = i?.updatedBy;
  }
  return v;
}
