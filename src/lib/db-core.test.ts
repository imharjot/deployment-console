// The console DB adapters and migrations, on in-memory SQLite — and on a real Postgres when PG_TEST_URL is set
// (scripts/pg-test.mjs starts a throwaway one): every case runs on both dialects unless it says otherwise.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { activeDb, inTransaction, insertAudit, migrate, MIGRATIONS, openDb, openPostgres, openSqlite, type Db } from "./db-core.ts";

interface Fresh {
  db: Db;
  url?: string;
  open(): Promise<Db>; // another connection (pool) to the same database
}

// A database of its own per test: SQLite in memory, or a new Postgres database dropped at the end.
const PG = process.env.PG_TEST_URL;
const dropLater: (() => Promise<void>)[] = [];
after(async () => {
  for (const d of dropLater.reverse()) await d().catch(() => {});
});

async function freshPg(base: string, migrated: boolean): Promise<Fresh> {
  const pg = (await import("pg")).default;
  const name = `dc_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  const opened: Db[] = [];
  const open = async () => {
    const d = await openPostgres(url);
    opened.push(d);
    return d;
  };
  const db = await open();
  if (migrated) await migrate(db);
  dropLater.push(async () => {
    for (const d of opened) await d.close?.().catch(() => {});
    const a = new pg.Client({ connectionString: base });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });
  return { db, url, open };
}

async function freshSqlite(migrated: boolean): Promise<Fresh> {
  const db = await openSqlite(":memory:");
  if (migrated) await migrate(db);
  return { db, open: async () => db };
}

const dialects: [string, (migrated?: boolean) => Promise<Fresh>][] = [
  ["sqlite", (m = true) => freshSqlite(m)],
  ...(PG ? ([["postgres", (m = true) => freshPg(PG, m)]] as [string, (migrated?: boolean) => Promise<Fresh>][]) : []),
];

const versions = async (db: Db) => (await db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).map((r) => Number(r.version));
async function columns(db: Db, table: string) {
  if (db.kind === "sqlite") return (await db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
  return (await db.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?", [table])).map((r) => r.name);
}
function within<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer within ${ms} ms (deadlock?)`)), ms).unref())]);
}

const TABLES = [
  "operations", "mutation_locks", "host_reservations", "inventory_runs", "dashboards", "user_prefs", "pins", "saved_items",
  "agent_connections", "agent_definitions", "workflows", "agent_runs", "agent_steps", "agent_model_calls", "approval_grants",
  "agent_tokens", "events", "outbox", "trigger_fires", "schedules",
];

for (const [dialect, fresh] of dialects) {
  describe(`db-core on ${dialect}`, () => {
    test("migrations apply to a fresh database: versions 1–7, every table of §3.2, the critic columns", async () => {
      const { db } = await fresh();
      assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(MIGRATIONS.length, 7);
      for (const t of TABLES) assert.ok((await columns(db, t)).length > 0, `table ${t}`);
      assert.ok((await columns(db, "audit")).includes("operation_id"));
      assert.ok((await columns(db, "audit")).includes("region"));
      assert.ok((await columns(db, "users")).includes("oidc_sub"));
      for (const c of ["run_id", "grant_id", "plan_hash"]) assert.ok((await columns(db, "approvals")).includes(c), c);
      for (const c of ["retry_safe", "idempotency_key", "grant_id", "fence", "lease_until"]) assert.ok((await columns(db, "agent_steps")).includes(c), c);
      for (const c of ["tools_hash", "reserved", "resource_key", "policy_hash"]) assert.ok((await columns(db, "agent_runs")).includes(c), c);
      for (const c of ["kind", "name", "owner_id", "definition_id", "definition_version", "policy_hash", "uses", "last_used_at"])
        assert.ok((await columns(db, "agent_tokens")).includes(c), c);
      assert.ok((await columns(db, "agent_connections")).includes("binding"));
      assert.ok((await columns(db, "schedules")).includes("workflow_version"));
    });

    test("events get an increasing numeric seq (AUTOINCREMENT / BIGSERIAL)", async () => {
      const { db } = await fresh();
      for (const type of ["a", "b", "c"]) await db.run("INSERT INTO events (at, type, payload) VALUES (?, ?, ?)", [Date.now(), type, "{}"]);
      const seqs = (await db.all<{ seq: number }>("SELECT seq FROM events ORDER BY seq")).map((r) => r.seq);
      assert.deepEqual(seqs, [1, 2, 3]);
      assert.equal(typeof seqs[0], "number");
      await db.run("DELETE FROM events WHERE seq = 3");
      await db.run("INSERT INTO events (at, type) VALUES (?, ?)", [Date.now(), "d"]);
      assert.equal((await db.get<{ seq: number }>("SELECT max(seq) AS seq FROM events"))?.seq, 4, "a deleted seq is never reused");
    });

    test("migrate() again is a no-op, and every statement is idempotent on its own", async () => {
      const { db } = await fresh();
      await migrate(db);
      assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7]);
      // Forget versions 4–7 and run them again over the existing tables and columns.
      await db.run("DELETE FROM schema_migrations WHERE version >= 4");
      await migrate(db);
      assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7]);
    });

    test("an existing v3 database upgrades with its rows intact", async () => {
      const { db } = await fresh(false);
      await migrate(db, MIGRATIONS.slice(0, 3));
      assert.deepEqual(await versions(db), [1, 2, 3]);
      await db.run("INSERT INTO users (id, email, role, created_at) VALUES ('u1', 'a@acme.example', 'admin', 1)");
      await db.run("INSERT INTO audit (id, at, phase, env, action, actor, params) VALUES ('a1', 2, 'intent', 'staging', 'restart', 'a@acme.example', '{}')");
      await db.run("INSERT INTO approvals (id, op, input, requested_by, status, created_at) VALUES ('p1', 'services.restart', '{}', 'u1', 'pending', 3)");
      await db.run("INSERT INTO notes (id, rkey, body, author, created_at, updated_at) VALUES ('n1', 'ecs:service/c/s', 'hi', 'a@acme.example', 4, 4)");
      await db.run("INSERT INTO settings (key, value) VALUES ('desired:staging/api', '2')");
      await migrate(db);
      assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual({ ...(await db.get("SELECT email, oidc_sub FROM users WHERE id = 'u1'")) }, { email: "a@acme.example", oidc_sub: null });
      assert.deepEqual({ ...(await db.get("SELECT action, operation_id, region FROM audit WHERE id = 'a1'")) }, { action: "restart", operation_id: null, region: null });
      assert.deepEqual({ ...(await db.get("SELECT status, plan_hash FROM approvals WHERE id = 'p1'")) }, { status: "pending", plan_hash: null });
      assert.equal((await db.get<{ body: string }>("SELECT body FROM notes WHERE id = 'n1'"))?.body, "hi");
      assert.equal((await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'desired:staging/api'"))?.value, "2");
      // users.oidc_sub: unique when set, any number of NULLs (F63).
      await db.run("INSERT INTO users (id, email, role, created_at) VALUES ('u2', 'b@acme.example', 'viewer', 5)");
      await db.run("UPDATE users SET oidc_sub = 'sub-1' WHERE id = 'u1'");
      await assert.rejects(db.run("UPDATE users SET oidc_sub = 'sub-1' WHERE id = 'u2'"));
    });

    test("R07: an audit row written while another request's transaction is open survives that transaction's rollback", async () => {
      const { db } = await fresh();
      let opened!: () => void;
      const isOpen = new Promise<void>((r) => (opened = r));
      let fail!: () => void;
      const failing = new Promise<void>((r) => (fail = r));
      const other = db
        .tx(async (tx) => {
          await tx.run("INSERT INTO settings (key, value) VALUES ('r07', 'x')");
          opened();
          await failing;
          throw new Error("unrelated failure");
        })
        .catch((e: Error) => e.message);
      await isOpen;
      let acknowledged = false;
      const write = insertAudit(db, { at: Date.now(), phase: "intent", env: "staging", target: "api", action: "restart", user: "a@acme.example" }, "audit-r07").then(
        () => (acknowledged = true),
      );
      await new Promise((r) => setTimeout(r, 30));
      if (dialect === "sqlite") assert.equal(acknowledged, false, "SQLite: the insert waits for the open transaction instead of joining it");
      fail();
      assert.equal(await other, "unrelated failure");
      await within(write);
      assert.equal(acknowledged, true);
      assert.ok(await db.get("SELECT 1 AS x FROM audit WHERE id = 'audit-r07'"), "the acknowledged audit row is still there");
      assert.equal(await db.get("SELECT 1 AS x FROM settings WHERE key = 'r07'"), undefined, "the failed transaction's own row is gone");
    });

    test("inside tx(), a handle captured outside and nested calls join the transaction (no deadlock) and roll back with it", async () => {
      const { db } = await fresh();
      await assert.rejects(
        within(
          db.tx(async (tx) => {
            await tx.run("INSERT INTO settings (key, value) VALUES ('t1', '1')");
            await db.run("INSERT INTO settings (key, value) VALUES ('t2', '2')"); // the base handle → routed
            assert.equal(activeDb(db), tx);
            assert.equal(inTransaction(), true);
            await activeDb(db).run("INSERT INTO settings (key, value) VALUES ('t3', '3')");
            assert.equal((await db.all("SELECT key FROM settings WHERE key IN ('t1', 't2', 't3')")).length, 3);
            throw new Error("roll back");
          }),
        ),
        /roll back/,
      );
      assert.equal((await db.all("SELECT key FROM settings WHERE key IN ('t1', 't2', 't3')")).length, 0);
      assert.equal(activeDb(db), db, "outside a transaction, the handle is the database itself");
    });

    test("a nested tx() is a savepoint: an inner failure undoes only the inner part", async () => {
      const { db } = await fresh();
      await db.tx(async (tx) => {
        await tx.run("INSERT INTO settings (key, value) VALUES ('outer', '1')");
        await assert.rejects(
          db.tx(async (inner) => {
            await inner.run("INSERT INTO settings (key, value) VALUES ('inner', '1')");
            throw new Error("inner fails");
          }),
        );
        await tx.tx(async (inner) => inner.run("INSERT INTO settings (key, value) VALUES ('inner2', '1')"));
      });
      const keys = (await db.all<{ key: string }>("SELECT key FROM settings WHERE key IN ('outer', 'inner', 'inner2') ORDER BY key")).map((r) => r.key);
      assert.deepEqual(keys, ["inner2", "outer"]);
    });

    test("a tx handle used after its transaction ended refuses instead of running outside it", async () => {
      const { db } = await fresh();
      let leaked!: Db;
      await db.tx(async (tx) => {
        leaked = tx;
      });
      await assert.rejects(leaked.run("INSERT INTO settings (key, value) VALUES ('late', '1')"), /already finished/);
      assert.equal(await db.get("SELECT 1 AS x FROM settings WHERE key = 'late'"), undefined);
    });

    test("a statement started inside a transaction but finishing after it (fire-and-forget) falls back to the database", async () => {
      const { db } = await fresh();
      let later!: Promise<number>;
      await db.tx(async () => {
        later = new Promise<void>((r) => setTimeout(r, 20)).then(() => db.run("INSERT INTO settings (key, value) VALUES ('ff', '1')"));
      });
      assert.equal(await within(later), 1);
      assert.ok(await db.get("SELECT 1 AS x FROM settings WHERE key = 'ff'"));
    });

    test("insertAudit stores operation id and region", async () => {
      const { db } = await fresh();
      await insertAudit(db, { at: 9, phase: "result", user: "a@acme.example", result: "unknown", operationId: "op-1", region: "eu-west-1", params: { n: 1 } }, "aud-1");
      const r = await db.get<Record<string, unknown>>("SELECT result, operation_id, region, params FROM audit WHERE id = 'aud-1'");
      assert.deepEqual({ ...r }, { result: "unknown", operation_id: "op-1", region: "eu-west-1", params: '{"n":1}' });
    });

    test("the lease upsert (ON CONFLICT … WHERE … RETURNING) takes a free or expired key and refuses a live one", async () => {
      const { db } = await fresh();
      const LEASE = `INSERT INTO mutation_locks (key, operation_id, owner, fence, acquired_at, expires_at) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT (key) DO UPDATE SET operation_id = excluded.operation_id, owner = excluded.owner, fence = mutation_locks.fence + 1,
          acquired_at = excluded.acquired_at, expires_at = excluded.expires_at WHERE mutation_locks.expires_at < ? RETURNING fence`;
      assert.deepEqual({ ...(await db.get(LEASE, ["k", "o1", "b", 100, 200, 100])) }, { fence: 1 });
      assert.equal(await db.get(LEASE, ["k", "o2", "b", 150, 250, 150]), undefined, "live lease");
      assert.deepEqual({ ...(await db.get(LEASE, ["k", "o2", "b", 300, 400, 300])) }, { fence: 2 }, "expired → taken over, fence + 1");
      await db.run("UPDATE mutation_locks SET expires_at = 0 WHERE key = 'k' AND fence = 2");
      assert.deepEqual({ ...(await db.get(LEASE, ["k", "o3", "b", 310, 410, 310])) }, { fence: 3 }, "released → free, the fence keeps growing");
    });

    if (dialect === "sqlite") {
      test("SQLite: concurrent read-modify-write transactions never interleave", async () => {
        const { db } = await fresh();
        await db.run("INSERT INTO settings (key, value) VALUES ('n', '0')");
        const bump = () =>
          db.tx(async (tx) => {
            const n = Number((await tx.get<{ value: string }>("SELECT value FROM settings WHERE key = 'n'"))?.value);
            await new Promise((r) => setImmediate(r));
            await tx.run("UPDATE settings SET value = ? WHERE key = 'n'", [String(n + 1)]);
          });
        await within(Promise.all(Array.from({ length: 40 }, bump)));
        assert.equal((await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'n'"))?.value, "40");
      });

      test("SQLite: ADD COLUMN tolerates a column that already exists", async () => {
        const { db } = await fresh(false);
        await migrate(db, MIGRATIONS.slice(0, 3));
        await db.run("ALTER TABLE audit ADD COLUMN operation_id TEXT");
        await migrate(db);
        assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7]);
      });

      test("another bundle's copy of this module routes the same transactions (shared state on globalThis)", async () => {
        const { db } = await fresh();
        const path = "./db-core.ts";
        const other = (await import(`${path}?bundle`)) as typeof import("./db-core.ts");
        assert.notEqual(other.activeDb, activeDb, "really a second module instance");
        await db.tx(async (tx) => {
          assert.equal(other.activeDb(db), tx);
          assert.equal(other.inTransaction(), true);
        });
        assert.equal(other.inTransaction(), false);
        await other.migrate(db); // the other copy can migrate a Db this one opened
      });

      test("openDb: SQLite without DATABASE_URL, migrated", async () => {
        const db = await openDb({ sqlitePath: ":memory:" });
        assert.equal(db.kind, "sqlite");
        assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7]);
      });
    }

    if (dialect === "postgres") {
      test("Postgres: two concurrent migrators apply each version exactly once (advisory lock)", async () => {
        const f = await fresh(false);
        const other = await f.open();
        await within(Promise.all([migrate(f.db), migrate(other), migrate(f.db)]), 20_000);
        assert.deepEqual(await versions(f.db), [1, 2, 3, 4, 5, 6, 7]);
        assert.equal(Number((await f.db.get<{ n: number }>("SELECT count(*) AS n FROM schema_migrations"))?.n), 7);
      });

      test("Postgres: the pool carries the timeouts (F32); migrations run without them", async () => {
        const f = await fresh(false);
        const r = await f.db.get<{ statement_timeout: string }>("SHOW statement_timeout");
        assert.equal(r?.statement_timeout, "15s");
        // A long index build must not be cancelled at 15 s: the migrator's own connection has no statement timeout.
        await migrate(f.db, [["CREATE TABLE migration_probe AS SELECT current_setting('statement_timeout') AS v"]]);
        assert.equal((await f.db.get<{ v: string }>("SELECT v FROM migration_probe"))?.v, "0");
      });
    }
  });
}
