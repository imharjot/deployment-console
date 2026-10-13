// The console's own database: adapters, schema and migrations. Pure (no "server-only"), so `node --test` runs it
// against in-memory SQLite and — with PG_TEST_URL, see scripts/pg-test.mjs — a real Postgres. src/lib/server/db.ts
// keeps the one connection per process on globalThis and re-exports this module.
// SQLite (built into Node 24) by default; Postgres when DATABASE_URL is set. SQL is written once in a portable
// subset with `?` placeholders; the Postgres adapter renumbers them.
//
// Isolation (REVIEW R07). SQLite has a single connection per process, so every statement goes through one async
// mutex: tx() holds it for the whole transaction and hands out a tx-bound Db, and a statement from anywhere else waits
// until that transaction has ended — it can never join (and be rolled back with) another request's transaction.
// Calls made *inside* a transaction — a nested getDb(), a handle captured before tx() — are routed to the tx handle by
// an AsyncLocalStorage on globalThis (shared by every Next bundle), so they neither deadlock nor slip outside it.
// Postgres gets the same routing; every other statement takes a pooled connection of its own.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;

export interface Db {
  kind: "sqlite" | "postgres";
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<number>; // rows changed
  // Commits when fn resolves, rolls back when it throws. Nested calls (on the handle or via routing) are savepoints.
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

// A migration statement: portable SQL, or one text per dialect.
export type Statement = string | { sqlite: string; postgres: string };

// SQLite has no ADD COLUMN IF NOT EXISTS; its runner tolerates "duplicate column name" instead.
const addColumn = (table: string, def: string): Statement => ({
  sqlite: `ALTER TABLE ${table} ADD COLUMN ${def}`,
  postgres: `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${def}`,
});

// Append only; never edit a committed version (add a new one). Each version runs once, inside one transaction
// together with its schema_migrations row (Postgres: under an advisory lock, so concurrent first boots are safe).
// Statements stay idempotent anyway. All timestamps are BIGINT milliseconds.
export const MIGRATIONS: Statement[][] = [
  [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, role TEXT NOT NULL,
      password_hash TEXT, disabled INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, last_login_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL, ip TEXT, user_agent TEXT)`,
    `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
    `CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL,
      expires_at BIGINT NOT NULL, used_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at BIGINT NOT NULL, phase TEXT NOT NULL, env TEXT, target TEXT,
      action TEXT, actor TEXT, ip TEXT, reason TEXT, params TEXT, result TEXT, detail TEXT)`,
    `CREATE INDEX IF NOT EXISTS audit_at ON audit(at)`,
    `CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT,
      events TEXT, updated_at BIGINT, updated_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, integration TEXT NOT NULL, event TEXT NOT NULL,
      at BIGINT NOT NULL, ok INTEGER NOT NULL, detail TEXT)`,
    `CREATE INDEX IF NOT EXISTS deliveries_at ON deliveries(at)`,
    // Not written yet: uptime history lives in process memory (src/lib/history.ts). Kept so migration 1 never changes.
    `CREATE TABLE IF NOT EXISTS state_changes (id TEXT PRIMARY KEY, env TEXT NOT NULL, rkey TEXT NOT NULL,
      state TEXT NOT NULL, at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS state_changes_key ON state_changes(env, rkey, at)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ],
  // 2: agents — API tokens (only sha256 of the token is stored) and approval requests (input sealed by secrets.ts).
  [
    `CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
      mode TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at BIGINT NOT NULL, last_used_at BIGINT,
      expires_at BIGINT, revoked_at BIGINT, uses BIGINT NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id)`,
    `CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, op TEXT NOT NULL, input TEXT NOT NULL, plan TEXT, env TEXT,
      token_id TEXT, requested_by TEXT NOT NULL, status TEXT NOT NULL, created_at BIGINT NOT NULL, decided_at BIGINT,
      decided_by TEXT, result TEXT, detail TEXT)`,
    `CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS approvals_token ON approvals(token_id, created_at)`,
  ],
  // 3: notes people attach to any resource, keyed by the inventory's resource key (see src/lib/server/notes.ts).
  [
    `CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, rkey TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      resource_name TEXT, env TEXT)`,
    `CREATE INDEX IF NOT EXISTS notes_rkey ON notes(rkey)`,
    `CREATE INDEX IF NOT EXISTS notes_updated ON notes(updated_at)`,
  ],
  // 4: integrity and auth — the audit-by-environment index (F61), audit rows linked to their operation (and region),
  // SSO accounts bound to the provider's subject (F63), approvals bound to an agent run, grant and exact plan.
  [
    `CREATE INDEX IF NOT EXISTS audit_env_at ON audit(env, at)`,
    addColumn("audit", "operation_id TEXT"),
    addColumn("audit", "region TEXT"),
    `CREATE INDEX IF NOT EXISTS audit_operation ON audit(operation_id)`,
    addColumn("users", "oidc_sub TEXT"),
    `CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL`,
    addColumn("approvals", "run_id TEXT"),
    addColumn("approvals", "grant_id TEXT"),
    addColumn("approvals", "plan_hash TEXT"),
  ],
  // 5: operations and coordination (src/lib/mutation-core.ts). One row per change that reached its audit intent;
  // mutation_locks are fenced leases on canonical resource keys (src/lib/mutation-keys.ts) — released by setting
  // expires_at = 0, never deleted, so the fence only grows. Host reservations count launched-but-unregistered EC2
  // hosts against the cap (R23); inventory_runs keep each provider's last result so a restart serves a labelled stale
  // map instead of nothing (R18).
  [
    `CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, action TEXT NOT NULL,
      actor TEXT NOT NULL, actor_kind TEXT NOT NULL, user_id TEXT, token_id TEXT, run_id TEXT, step_id TEXT, grant_id TEXT,
      approval_id TEXT, env TEXT, region TEXT, targets TEXT NOT NULL, input_hash TEXT, plan_hash TEXT, params TEXT,
      state TEXT NOT NULL, request_ids TEXT, result TEXT, error TEXT, fence BIGINT NOT NULL DEFAULT 0, boot_id TEXT,
      created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT, verify TEXT, verified_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS operations_state ON operations(state, created_at)`,
    `CREATE INDEX IF NOT EXISTS operations_run ON operations(run_id)`,
    `CREATE TABLE IF NOT EXISTS mutation_locks (key TEXT PRIMARY KEY, operation_id TEXT, owner TEXT,
      fence BIGINT NOT NULL DEFAULT 0, acquired_at BIGINT, expires_at BIGINT NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS mutation_locks_operation ON mutation_locks(operation_id)`,
    `CREATE TABLE IF NOT EXISTS host_reservations (id TEXT PRIMARY KEY, env TEXT NOT NULL, region TEXT, cluster TEXT NOT NULL,
      operation_id TEXT, count INTEGER NOT NULL, instance_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL,
      created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, detail TEXT)`,
    `CREATE INDEX IF NOT EXISTS host_reservations_env ON host_reservations(env, state)`,
    `CREATE TABLE IF NOT EXISTS inventory_runs (provider TEXT NOT NULL, region TEXT NOT NULL, at BIGINT NOT NULL,
      status TEXT NOT NULL, result TEXT, PRIMARY KEY (provider, region))`,
  ],
  // 6: personal workspace — dashboards (private or team), preferences, pins and saved views / log queries.
  [
    `CREATE TABLE IF NOT EXISTS dashboards (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      visibility TEXT NOT NULL DEFAULT 'private', min_role TEXT, widgets TEXT NOT NULL DEFAULT '[]', layout TEXT NOT NULL DEFAULT '{}',
      template TEXT, version INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS dashboards_owner ON dashboards(owner_id)`,
    `CREATE INDEX IF NOT EXISTS dashboards_visibility ON dashboards(visibility)`,
    `CREATE TABLE IF NOT EXISTS user_prefs (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      updated_at BIGINT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS pins (user_id TEXT NOT NULL, rkey TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, env TEXT,
      region TEXT, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, rkey))`,
    `CREATE TABLE IF NOT EXISTS saved_items (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      payload TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS saved_items_owner ON saved_items(owner_id, kind)`,
  ],
  // 7: agents (row types in src/lib/agents/records.ts). Credentials and transcripts are sealed by secrets.ts; tokens
  // keep only a hash; events carry an ordered cursor for replay (SSE Last-Event-ID) and feed the outbox.
  [
    `CREATE TABLE IF NOT EXISTS agent_connections (id TEXT PRIMARY KEY, owner_id TEXT, scope TEXT NOT NULL, provider TEXT NOT NULL,
      auth_kind TEXT NOT NULL, label TEXT NOT NULL, endpoint TEXT, model TEXT, region TEXT, credential TEXT, key_version INTEGER,
      egress TEXT NOT NULL DEFAULT 'cloud', background_ok INTEGER NOT NULL DEFAULT 0, eligibility TEXT, binding TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_used_at BIGINT,
      revoked_at BIGINT, revoke_confirmed INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS agent_connections_owner ON agent_connections(owner_id)`,
    `CREATE TABLE IF NOT EXISTS agent_definitions (id TEXT NOT NULL, version INTEGER NOT NULL, owner_id TEXT, name TEXT NOT NULL,
      config_hash TEXT NOT NULL, instructions TEXT, tools TEXT, policy TEXT, model_req TEXT, created_at BIGINT NOT NULL,
      archived_at BIGINT, PRIMARY KEY (id, version))`,
    `CREATE TABLE IF NOT EXISTS workflows (id TEXT NOT NULL, version INTEGER NOT NULL, owner_id TEXT, name TEXT NOT NULL, hash TEXT,
      graph TEXT, triggers TEXT, scope TEXT, policy TEXT, connection_id TEXT, principal TEXT, state TEXT NOT NULL DEFAULT 'draft',
      created_at BIGINT NOT NULL, published_at BIGINT, disabled_at BIGINT, PRIMARY KEY (id, version))`,
    `CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, initiator_id TEXT, principal TEXT,
      agent_id TEXT, agent_version INTEGER, workflow_id TEXT, workflow_version INTEGER, connection_id TEXT, scope TEXT, policy TEXT,
      policy_hash TEXT, tools_hash TEXT, state TEXT NOT NULL, budget TEXT, usage TEXT, reserved TEXT, trigger TEXT,
      parent_run_id TEXT, resource_key TEXT, deadline_at BIGINT, cancel_requested_at BIGINT, created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL, finished_at BIGINT, error TEXT)`,
    `CREATE INDEX IF NOT EXISTS agent_runs_state ON agent_runs(state, updated_at)`,
    `CREATE INDEX IF NOT EXISTS agent_runs_initiator ON agent_runs(initiator_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS agent_runs_parent ON agent_runs(parent_run_id)`,
    `CREATE TABLE IF NOT EXISTS agent_steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
      name TEXT, depends TEXT, attempt INTEGER NOT NULL DEFAULT 0, retry_safe INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT,
      state TEXT NOT NULL, lease_owner TEXT, lease_until BIGINT, fence BIGINT NOT NULL DEFAULT 0, wake_at BIGINT, input TEXT,
      result TEXT, error TEXT, operation_id TEXT, grant_id TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      UNIQUE (run_id, seq))`,
    `CREATE INDEX IF NOT EXISTS agent_steps_wake ON agent_steps(state, wake_at)`,
    `CREATE INDEX IF NOT EXISTS agent_steps_lease ON agent_steps(lease_until)`,
    `CREATE TABLE IF NOT EXISTS agent_model_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT, connection_id TEXT,
      provider TEXT, model TEXT, request_id TEXT, state TEXT NOT NULL, usage TEXT, cost_estimate REAL, transcript TEXT,
      started_at BIGINT NOT NULL, finished_at BIGINT, error TEXT)`,
    `CREATE INDEX IF NOT EXISTS agent_model_calls_run ON agent_model_calls(run_id)`,
    `CREATE TABLE IF NOT EXISTS approval_grants (id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, principal TEXT, operation TEXT NOT NULL,
      op_version TEXT, targets TEXT, input_hash TEXT, plan_hash TEXT, artifact_hashes TEXT, preconditions TEXT, policy_hash TEXT,
      limits TEXT, approval_id TEXT, requested_at BIGINT NOT NULL, expires_at BIGINT, decision TEXT, decided_by TEXT,
      decided_at BIGINT, reason TEXT, invalidated_at BIGINT, invalidation_reason TEXT, consumed_at BIGINT,
      consumed_operation_id TEXT)`,
    `CREATE INDEX IF NOT EXISTS approval_grants_run ON approval_grants(run_id)`,
    `CREATE INDEX IF NOT EXISTS approval_grants_approval ON approval_grants(approval_id)`,
    `CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, owner_id TEXT, definition_id TEXT,
      definition_version INTEGER, run_id TEXT, principal TEXT, policy_hash TEXT, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
      scope TEXT, uses BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, last_used_at BIGINT, expires_at BIGINT,
      revoked_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS agent_tokens_owner ON agent_tokens(owner_id)`,
    `CREATE INDEX IF NOT EXISTS agent_tokens_run ON agent_tokens(run_id)`,
    {
      sqlite: `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at BIGINT NOT NULL, type TEXT NOT NULL,
        topic TEXT, run_id TEXT, actor TEXT, audience TEXT, payload TEXT)`,
      postgres: `CREATE TABLE IF NOT EXISTS events (seq BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, type TEXT NOT NULL,
        topic TEXT, run_id TEXT, actor TEXT, audience TEXT, payload TEXT)`,
    },
    `CREATE INDEX IF NOT EXISTS events_at ON events(at)`,
    `CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq)`,
    `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, event_seq BIGINT, target TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at BIGINT, last_error TEXT, created_at BIGINT NOT NULL, delivered_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state, next_at)`,
    `CREATE TABLE IF NOT EXISTS trigger_fires (dedupe_key TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER,
      run_id TEXT, at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER, cron TEXT NOT NULL,
      tz TEXT, next_at BIGINT, last_fired_at BIGINT, enabled INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS schedules_next ON schedules(next_at)`,
  ],
];

export const sqlFor = (s: Statement, kind: Db["kind"]) => (typeof s === "string" ? s : s[kind]);

// ---------- transaction routing (shared by every bundle) ----------

interface TxScope {
  owner: object; // the connection this transaction belongs to
  db: Db; // its tx-bound handle
  open: boolean;
}
const txAls: AsyncLocalStorage<TxScope> = ((globalThis as { __consoleDbAls?: AsyncLocalStorage<TxScope> }).__consoleDbAls ??=
  new AsyncLocalStorage<TxScope>());
const routed = (owner: object) => {
  const s = txAls.getStore();
  return s && s.owner === owner && s.open ? s.db : undefined;
};
// The handle a caller in this async context should use: the open transaction's when inside one, else db itself.
export const activeDb = (db: Db): Db => (internals.get(db) && routed(internals.get(db)!.owner)) || db;
// Whether this async context is inside an open transaction (of any connection).
export const inTransaction = () => !!txAls.getStore()?.open;

// What migrate() needs beyond the Db interface (the raw connection or pool).
// On globalThis too: the Db is created by whichever bundle opens it first and used by all of them.
interface Internals {
  owner: object;
  migrate(migrations: Statement[][]): Promise<void>;
}
const internals: WeakMap<Db, Internals> = ((globalThis as { __consoleDbInternals?: WeakMap<Db, Internals> }).__consoleDbInternals ??= new WeakMap<Db, Internals>());

// FIFO async mutex.
function mutex() {
  let tail: Promise<void> = Promise.resolve();
  return async <T,>(fn: () => T | Promise<T>): Promise<T> => {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = tail;
    tail = prev.then(() => mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const finished = () => new Error("this transaction has already finished; use the handle only inside tx()");
const clean = (p: unknown[]) => p.map((v) => (typeof v === "boolean" ? Number(v) : v === undefined ? null : v));
const duplicateColumn = (sql: string, e: unknown) => /^\s*ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN/i.test(sql) && /duplicate column/i.test(String((e as Error)?.message));

// ---------- SQLite ----------

export async function openSqlite(file: string): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const args = (p: unknown[]) => clean(p) as (string | number | null)[];
  const all = <T,>(sql: string, p: unknown[] = []) => conn.prepare(sql).all(...args(p)).map((r) => ({ ...r }) as T);
  const get = <T,>(sql: string, p: unknown[] = []) => {
    const r = conn.prepare(sql).get(...args(p));
    return r ? ({ ...r } as T) : undefined;
  };
  const run = (sql: string, p: unknown[] = []) => Number(conn.prepare(sql).run(...args(p)).changes);
  const rollback = (to?: string) => {
    try {
      conn.exec(to ? `ROLLBACK TO ${to}; RELEASE ${to}` : "ROLLBACK");
    } catch {
      // SQLite already rolled back (e.g. after SQLITE_FULL); nothing left to undo.
    }
  };
  const locked = mutex();
  const owner = {};

  // The handle passed to fn: runs directly (its transaction holds the mutex) and refuses once that has ended.
  const bound = (scope: TxScope): Db => {
    let depth = 0;
    const live = () => {
      if (!scope.open) throw finished();
    };
    return {
      kind: "sqlite",
      all: async <T,>(sql: string, p?: unknown[]) => (live(), all<T>(sql, p)),
      get: async <T,>(sql: string, p?: unknown[]) => (live(), get<T>(sql, p)),
      run: async (sql: string, p?: unknown[]) => (live(), run(sql, p)),
      tx: async <T,>(fn: (db: Db) => Promise<T>) => {
        live();
        const sp = `sp_${++depth}`;
        conn.exec(`SAVEPOINT ${sp}`);
        try {
          const out = await fn(scope.db);
          conn.exec(`RELEASE ${sp}`);
          return out;
        } catch (e) {
          rollback(sp);
          throw e;
        } finally {
          depth--;
        }
      },
    };
  };

  const db: Db = {
    kind: "sqlite",
    all: <T,>(sql: string, p?: unknown[]) => routed(owner)?.all<T>(sql, p) ?? locked(() => all<T>(sql, p)),
    get: <T,>(sql: string, p?: unknown[]) => routed(owner)?.get<T>(sql, p) ?? locked(() => get<T>(sql, p)),
    run: (sql: string, p?: unknown[]) => routed(owner)?.run(sql, p) ?? locked(() => run(sql, p)),
    tx: <T,>(fn: (db: Db) => Promise<T>) =>
      routed(owner)?.tx(fn) ??
      locked(async () => {
        const scope: TxScope = { owner, open: true, db: undefined as unknown as Db };
        scope.db = bound(scope);
        conn.exec("BEGIN IMMEDIATE");
        try {
          const out = await txAls.run(scope, () => fn(scope.db));
          conn.exec("COMMIT");
          return out;
        } catch (e) {
          rollback();
          throw e;
        } finally {
          scope.open = false;
        }
      }),
    close: () => locked(() => conn.close()),
  };

  internals.set(db, {
    owner,
    // Whole run under the mutex; each version and its schema_migrations row in one IMMEDIATE transaction, re-checked
    // inside it, so two processes opening the same file can't apply a version twice.
    migrate: (migrations) =>
      locked(() => {
        conn.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)");
        for (let v = 1; v <= migrations.length; v++) {
          if (get("SELECT 1 AS done FROM schema_migrations WHERE version = ?", [v])) continue;
          conn.exec("BEGIN IMMEDIATE");
          try {
            if (!get("SELECT 1 AS done FROM schema_migrations WHERE version = ?", [v])) {
              for (const s of migrations[v - 1]) {
                const sql = sqlFor(s, "sqlite");
                try {
                  conn.exec(sql);
                } catch (e) {
                  if (!duplicateColumn(sql, e)) throw e;
                }
              }
              run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [v, Date.now()]);
            }
            conn.exec("COMMIT");
          } catch (e) {
            rollback();
            throw new Error(`migration ${v} failed: ${(e as Error).message}`);
          }
        }
      }),
  });
  return db;
}

// ---------- Postgres ----------

export const PG_POOL = {
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000, // a hung database fails the request (503 page) instead of hanging it
  query_timeout: 15_000,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 60_000,
  keepAlive: true,
};
const MIGRATION_LOCK = 72_405_311; // pg_advisory_lock key: one migrator at a time across every process

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const logDb = (event: string, e: unknown) =>
  console.error(JSON.stringify({ level: "error", source: "deployment-console", component: "db", event, message: (e as Error)?.message ?? String(e), code: (e as { code?: string })?.code, at: new Date().toISOString() }));

export async function openPostgres(url: string): Promise<Db> {
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number(v)); // BIGINT timestamps (and BIGSERIAL) → number
  const pool = new pg.Pool({ connectionString: url, ...PG_POOL });
  pool.on("error", (e) => logDb("pg_pool_error", e)); // an idle client lost its connection; the pool replaces it
  const num = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  const owner = {};
  const on = (q: Queryable) => ({
    all: async <T,>(sql: string, p: unknown[] = []) => (await q.query(num(sql), clean(p))).rows as T[],
    get: async <T,>(sql: string, p: unknown[] = []) => (await q.query(num(sql), clean(p))).rows[0] as T | undefined,
    run: async (sql: string, p: unknown[] = []) => (await q.query(num(sql), clean(p))).rowCount ?? 0,
  });

  const bound = (client: Queryable, scope: TxScope): Db => {
    const ops = on(client);
    let depth = 0;
    const live = () => {
      if (!scope.open) throw finished();
    };
    return {
      kind: "postgres",
      all: async <T,>(sql: string, p?: unknown[]) => (live(), ops.all<T>(sql, p)),
      get: async <T,>(sql: string, p?: unknown[]) => (live(), ops.get<T>(sql, p)),
      run: async (sql: string, p?: unknown[]) => (live(), ops.run(sql, p)),
      tx: async <T,>(fn: (db: Db) => Promise<T>) => {
        live();
        const sp = `sp_${++depth}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const out = await fn(scope.db);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          return out;
        } catch (e) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
          throw e;
        } finally {
          depth--;
        }
      },
    };
  };

  const base = on(pool as unknown as Queryable);
  const db: Db = {
    kind: "postgres",
    all: <T,>(sql: string, p?: unknown[]) => routed(owner)?.all<T>(sql, p) ?? base.all<T>(sql, p),
    get: <T,>(sql: string, p?: unknown[]) => routed(owner)?.get<T>(sql, p) ?? base.get<T>(sql, p),
    run: (sql: string, p?: unknown[]) => routed(owner)?.run(sql, p) ?? base.run(sql, p),
    tx: async <T,>(fn: (db: Db) => Promise<T>) => {
      const inner = routed(owner);
      if (inner) return inner.tx(fn);
      const client = await pool.connect();
      const scope: TxScope = { owner, open: true, db: undefined as unknown as Db };
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        scope.db = bound(client as unknown as Queryable, scope);
        const out = await txAls.run(scope, () => fn(scope.db));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch((re: Error) => (broken = re)); // a dead connection is destroyed, not reused
        throw e;
      } finally {
        scope.open = false;
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };

  internals.set(db, {
    owner,
    // One dedicated connection, outside the pool and without its 15 s statement/query timeouts (an index build on a
    // large audit table, or waiting for another console's migration, may take longer), holds the session advisory lock
    // for the whole run. Each version and its schema_migrations row commit together, so a crash mid-version leaves
    // nothing half-applied and a concurrent boot waits, then skips.
    migrate: async (migrations) => {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: PG_POOL.connectionTimeoutMillis, keepAlive: true });
      client.on("error", (e) => logDb("pg_migrate_error", e));
      await client.connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
        await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)");
        const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => Number(r.version)));
        for (let v = 1; v <= migrations.length; v++) {
          if (done.has(v)) continue;
          await client.query("BEGIN");
          try {
            for (const s of migrations[v - 1]) await client.query(sqlFor(s, "postgres"));
            await client.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING", [v, Date.now()]);
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw new Error(`migration ${v} failed: ${(e as Error).message}`);
          }
        }
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      } finally {
        await client.end().catch(() => {}); // closing the session also drops a lock we couldn't release
      }
    },
  });
  return db;
}

// ---------- migrations ----------

export async function migrate(db: Db, migrations: Statement[][] = MIGRATIONS): Promise<void> {
  const i = internals.get(db);
  if (!i) throw new Error("migrate() needs a Db opened by openSqlite() or openPostgres()");
  if (routed(i.owner)) throw new Error("migrate() can't run inside a transaction");
  await i.migrate(migrations);
}

// Opens and migrates the database the environment names: DATABASE_URL (postgres://…) or SQLite at `sqlitePath`.
export async function openDb(o: { databaseUrl?: string; sqlitePath: string }): Promise<Db> {
  const url = o.databaseUrl;
  const db = url && /^postgres(ql)?:\/\//.test(url) ? await openPostgres(url) : await openSqlite(o.sqlitePath);
  try {
    await migrate(db);
  } catch (e) {
    await db.close?.().catch(() => {});
    throw e;
  }
  return db;
}

// ---------- audit rows ----------

// One audit row (src/lib/server/audit.ts writes these; the coordinator writes its intent inside its own transaction).
// Outside a transaction the insert is its own committed statement; inside one it commits with it.
export interface AuditRecord {
  at: number;
  phase: "intent" | "result";
  env?: string;
  target?: string;
  action?: string;
  user?: string;
  ip?: string;
  reason?: string;
  params?: Record<string, unknown>;
  result?: "ok" | "error" | "unknown";
  detail?: string;
  operationId?: string;
  region?: string;
}

export async function insertAudit(db: Db, e: AuditRecord, id: string = crypto.randomUUID()): Promise<void> {
  await db.run(
    "INSERT INTO audit (id, at, phase, env, target, action, actor, ip, reason, params, result, detail, operation_id, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, e.at, e.phase, e.env, e.target, e.action, e.user, e.ip, e.reason, JSON.stringify(e.params ?? {}), e.result, e.detail, e.operationId, e.region],
  );
}
