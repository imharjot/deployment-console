// The console's own database: users, sessions, one-time links, audit log, integrations, deliveries, settings,
// API tokens, approval requests, notes on resources, operations and their leases, dashboards and the agent tables.
// SQLite (built into Node 24) by default — one file under CONSOLE_DATA_DIR, fine for a single instance with a volume.
// Postgres when DATABASE_URL is set — needed for stateless (Fargate) or multi-instance deployments.
// Adapters, schema and migrations live in src/lib/db-core.ts (pure, tested against both); this keeps the one
// connection (pool) per process on globalThis, because routes and the instrumentation bundle load separate copies of
// this module and must share it — one SQLite connection, one transaction mutex, one Postgres pool.
import "server-only";
import path from "node:path";
import { activeDb, openDb, type Db } from "../db-core.ts";

export type { Db, Row } from "../db-core.ts";

// turbopackIgnore (here, below and in secrets.ts): a local `next build` must not trace data/ — the console DB and
// secret.key — into .next/standalone (outputFileTracingExcludes doesn't reach these traces).
export const dataDir = () => path.resolve(/*turbopackIgnore: true*/ process.env.CONSOLE_DATA_DIR || "data");

const g = globalThis as { __consoleDb?: Promise<Db> };

// Inside a db.tx() callback this resolves to that transaction's handle (src/lib/db-core.ts routes it), so helpers that
// call getDb() themselves join the transaction instead of waiting for it.
export function getDb(): Promise<Db> {
  const opening = (g.__consoleDb ??= openDb({
    databaseUrl: process.env.DATABASE_URL,
    sqlitePath: process.env.CONSOLE_SQLITE_PATH || path.join(/*turbopackIgnore: true*/ dataDir(), "console.db"),
  }).catch((e) => {
    g.__consoleDb = undefined; // let the next request retry (e.g. Postgres not up yet)
    throw e;
  }));
  return opening.then(activeDb);
}

export const newId = () => crypto.randomUUID();
