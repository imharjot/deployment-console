// Audit log in the console's own DB. Every console action writes an "intent" row before the AWS call and a
// "result" row after; if the intent can't be written the action is refused (callers fail closed). Changes go through
// the mutation coordinator (./mutations.ts), which commits the intent together with its operation row.
// writeAudit() resolves only once the row is committed: on its own, or — called inside a db.tx() — together with that
// transaction (src/lib/db-core.ts never lets it join someone else's).
import "server-only";
import { insertAudit, type AuditRecord, type Db } from "../db-core.ts";
import type { AuditEntry } from "../types.ts";
import { getDb, newId } from "./db.ts";

// AuditEntry or the coordinator's AuditRecord (env/target optional). `db`: write through this handle (a transaction).
export async function writeAudit(e: AuditEntry | AuditRecord, db?: Db) {
  await insertAudit(db ?? (await getDb()), { ...e, params: e.params ?? {} }, newId());
}

interface Row {
  at: number;
  phase: string;
  env: string | null;
  target: string | null;
  action: string | null;
  actor: string | null;
  ip: string | null;
  reason: string | null;
  params: string | null;
  result: string | null;
  detail: string | null;
  operation_id: string | null;
  region: string | null;
}

const RESULTS = new Set(["ok", "error", "unknown"]);

export async function readAudit(limit: number, env?: string): Promise<AuditEntry[]> {
  const db = await getDb();
  const rows = env
    ? await db.all<Row>("SELECT * FROM audit WHERE env = ? ORDER BY at DESC LIMIT ?", [env, limit])
    : await db.all<Row>("SELECT * FROM audit ORDER BY at DESC LIMIT ?", [limit]);
  return rows.map((r) => ({
    at: Number(r.at),
    phase: r.phase === "intent" ? "intent" : "result",
    env: r.env ?? "",
    target: r.target ?? "",
    action: r.action ?? "",
    user: r.actor ?? "",
    ip: r.ip ?? undefined,
    reason: r.reason ?? undefined,
    params: safeJson(r.params),
    result: r.result && RESULTS.has(r.result) ? (r.result as AuditEntry["result"]) : undefined,
    detail: r.detail ?? undefined,
    operationId: r.operation_id ?? undefined,
    region: r.region ?? undefined,
  }));
}

const safeJson = (s: string | null) => {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// Remembered per service so "start" brings back the task count "stop" took away (ECS itself forgets it).
export async function rememberDesired(env: string, service: string, n: number) {
  const db = await getDb();
  await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [`desired:${env}/${service}`, String(n)]);
}

export async function recallDesired(env: string, service: string): Promise<number | undefined> {
  const db = await getDb();
  const r = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [`desired:${env}/${service}`]);
  const n = Number(r?.value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
