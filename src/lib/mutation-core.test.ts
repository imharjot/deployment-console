// The mutation coordinator on in-memory SQLite — and on a real Postgres when PG_TEST_URL is set (scripts/pg-test.mjs):
// every case runs on both dialects. Bodies stand in for AWS calls; gates (promises resolved by the test) hold them at
// the interesting points.
import { after, before, describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { migrate, openPostgres, openSqlite, type Db } from "./db-core.ts";
import {
  createMutations,
  mutationState,
  MutationError,
  newMutationState,
  PROCESS_KEY,
  PROCESS_TTL_MS,
  RESTARTED,
  safeSummary,
  scrub,
  type MutationActor,
  type MutationEvent,
  type MutationSpec,
  type OperationRow,
} from "./mutation-core.ts";
import { canonicalKey, keysForInventory } from "./mutation-keys.ts";
import { HttpError } from "./server/errors.ts";

const PG = process.env.PG_TEST_URL;
const cleanup: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
});

async function freshPg(base: string): Promise<{ db: Db; open(): Promise<Db>; url?: string }> {
  const pg = (await import("pg")).default;
  const name = `dc_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(base);
  u.pathname = `/${name}`;
  const opened: Db[] = [];
  const open = async () => {
    const d = await openPostgres(u.toString());
    opened.push(d);
    return d;
  };
  const db = await open();
  await migrate(db);
  cleanup.push(async () => {
    for (const d of opened) await d.close?.().catch(() => {});
    const a = new pg.Client({ connectionString: base });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });
  return { db, open, url: u.toString() };
}

async function freshSqlite() {
  const db = await openSqlite(":memory:");
  await migrate(db);
  return { db, open: async () => db };
}

type Fresh = () => Promise<{ db: Db; open(): Promise<Db>; url?: string }>;
const dialects: [string, Fresh][] = [["sqlite", freshSqlite], ...(PG ? ([["postgres", () => freshPg(PG)]] as [string, Fresh][]) : [])];

const alice: MutationActor = { display: "alice@acme.example", kind: "person", userId: "u-alice", ip: "10.0.0.1" };
const bob: MutationActor = { display: "bob@acme.example", kind: "person", userId: "u-bob" };
const env = { id: "staging", label: "Staging", protected: false, region: "us-east-1" };

let seq = 0;
const uniq = (p: string) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const status = (s: number, kind?: string) => (e: unknown) => {
  assert.ok(e instanceof HttpError, `expected an HttpError, got ${String(e)}`);
  assert.equal(e.status, s, e.message);
  if (kind) assert.equal((e as MutationError).kind, kind, e.message);
  return true;
};
const spec = (o: Partial<MutationSpec> & { keys: string[] }): MutationSpec => ({ action: "services.restart", actor: alice, env, target: "api", params: {}, ...o });

for (const [dialect, fresh] of dialects) {
  describe(`mutation coordinator on ${dialect}`, () => {
    let db: Db;
    let open: () => Promise<Db>;
    let m: ReturnType<typeof createMutations>;
    const op = (id: string) => db.get<OperationRow>("SELECT * FROM operations WHERE id = ?", [id]);
    const audits = (id: string) => db.all<{ phase: string; result: string | null; detail: string | null; region: string | null }>("SELECT phase, result, detail, region FROM audit WHERE operation_id = ? ORDER BY at, phase", [id]);
    const lease = (key: string) => db.get<{ fence: number; expires_at: number; operation_id: string }>("SELECT fence, expires_at, operation_id FROM mutation_locks WHERE key = ?", [key]);

    before(async () => {
      ({ db, open } = await fresh());
      m = createMutations({ db: async () => db });
    });

    test("R04: a map deploy and a variable save on the same ECS service — the second gets 409 and never runs; the first reads only under the lock", async () => {
      const cluster = uniq("acme-staging");
      const mapKeys = keysForInventory(`ecs:service/${cluster}/api`, "us-east-1", "us-east-1");
      const varKeys = [canonicalKey({ ecsService: { region: "us-east-1", cluster, service: "api" } })];
      assert.deepEqual(mapKeys, varKeys, "one canonical key for both surfaces");
      const log: string[] = [];
      const registering = gate();
      const deploy = m.mutate(spec({ action: "ecs-image.deploy-image", target: "api", keys: mapKeys, params: { image: "storefront-api:review" } }), async (h) => {
        const held = await lease(mapKeys[0]);
        assert.equal(Number(held?.fence), h.fences[mapKeys[0]], "the lease is held before the body reads anything");
        assert.ok(Number(held?.expires_at) > Date.now());
        log.push("deploy reads the live task definition");
        await registering.p; // RegisterTaskDefinition in flight
        await h.intent({ from: "api-staging:41" });
        log.push("deploy updates the service");
        h.requestId("req-901");
        return { taskDefinition: "arn:aws:ecs:us-east-1:123456789012:task-definition/api-staging:901" };
      });
      await until(() => log.length === 1);
      const save = m.mutate(spec({ action: "vars.edit", actor: bob, target: "api", keys: varKeys, params: { set: ["REVIEW"] } }), async (h) => {
        log.push("variable save ran");
        await h.intent();
        return {};
      });
      await assert.rejects(save, (e) => status(409, "busy")(e) && /in progress \(ecs-image\.deploy-image by alice@acme\.example\)/.test((e as Error).message));
      registering.open();
      const r = await deploy;
      assert.deepEqual(log, ["deploy reads the live task definition", "deploy updates the service"]);
      assert.deepEqual(r.requestIds, ["req-901"]);
      assert.equal((await op(r.operationId))?.state, "succeeded");
      // Once released, the variable save goes through.
      const later = await m.mutate(spec({ action: "vars.edit", actor: bob, keys: varKeys, params: {} }), async (h) => {
        await h.intent();
        return "ok";
      });
      assert.equal(later.result, "ok");
      assert.equal(Number((await lease(varKeys[0]))?.expires_at), 0, "released");
    });

    test("overlapping key sets under contention: no deadlock, every change eventually lands, nothing stays locked", async () => {
      const pool = Array.from({ length: 5 }, () => uniq("k"));
      const sets = Array.from({ length: 24 }, (_, i) => [pool[i % 5], pool[(i * 3 + 1) % 5], pool[(i + 2) % 5]]);
      let ran = 0;
      const one = async (keys: string[]) => {
        for (let attempt = 0; attempt < 400; attempt++) {
          try {
            return await m.mutate(spec({ keys, target: keys.join("+") }), async (h) => {
              await new Promise((r) => setTimeout(r, Math.random() * 3));
              await h.intent();
              ran++;
              return true;
            });
          } catch (e) {
            if (!(e instanceof MutationError && e.kind === "busy")) throw e;
            await new Promise((r) => setTimeout(r, Math.random() * 4));
          }
        }
        throw new Error("never got the keys");
      };
      const all = Promise.all(sets.map(one));
      await Promise.race([all, new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock: not done in 20 s")), 20_000).unref())]);
      assert.equal(ran, sets.length);
      for (const k of pool) {
        assert.equal(mutationState().held.has(k), false);
        assert.equal(Number((await lease(k))?.expires_at), 0);
      }
    });

    test("an expired lease is taken over with a new fence; the stale owner's assertOwner() and intent() throw and it can't free the new lease", async () => {
      const key = uniq("ecs-service:us-east-1/acme-staging/worker");
      let clock = 1_000_000_000;
      const procA = createMutations({ db: async () => db, now: () => clock, state: newMutationState() });
      const procB = createMutations({ db: async () => db, now: () => clock, state: newMutationState() });
      const aStarted = gate();
      const aGo = gate();
      const seen: string[] = [];
      let aFence = 0;
      const a = procA.mutate(spec({ keys: [key], leaseMs: 60_000 }), async (h) => {
        aFence = h.fences[key];
        aStarted.open();
        await aGo.p; // A stalls (GC pause, hung call) past its lease
        await h.assertOwner().catch((e: MutationError) => seen.push(`assertOwner ${e.status} ${e.kind}`));
        await h.intent(); // must refuse: the lease is someone else's now
        seen.push("A acted");
        return "a";
      });
      await aStarted.p;
      clock += 60_001;
      const bHold = gate();
      let bFence = 0;
      const b = procB.mutate(spec({ keys: [key], actor: bob }), async (h) => {
        bFence = h.fences[key];
        await h.intent();
        await bHold.p;
        return "b";
      });
      await until(() => bFence > 0);
      assert.equal(bFence, aFence + 1, "takeover increments the fence");
      aGo.open();
      await assert.rejects(a, status(409, "lost_lease"));
      assert.deepEqual(seen, ["assertOwner 409 lost_lease"], "A never reached its side effect");
      const held = await lease(key);
      assert.equal(Number(held?.fence), bFence);
      assert.ok(Number(held?.expires_at) > clock, "A's fenced release left B's lease alone");
      bHold.open();
      assert.equal((await b).result, "b");
      assert.equal(Number((await lease(key))?.expires_at), 0);
    });

    test("two processes racing for the same free key: exactly one wins (ON CONFLICT … WHERE)", async () => {
      const key = uniq("rds:us-east-1/orders");
      const p1 = createMutations({ db: async () => db, state: newMutationState() });
      const db2 = await open();
      const p2 = createMutations({ db: async () => db2, state: newMutationState() });
      const hold = gate();
      const body = async (h: { intent(): Promise<void> }) => {
        await h.intent();
        await hold.p;
        return 1;
      };
      const results = Promise.allSettled([p1.mutate(spec({ keys: [key] }), body), p2.mutate(spec({ keys: [key], actor: bob }), body)]);
      await new Promise((r) => setTimeout(r, 50));
      hold.open();
      const [r1, r2] = await results;
      const states = [r1.status, r2.status].sort();
      assert.deepEqual(states, ["fulfilled", "rejected"]);
      const lost = (r1.status === "rejected" ? r1 : r2) as PromiseRejectedResult;
      assert.ok(lost.reason instanceof MutationError && lost.reason.kind === "busy", String(lost.reason));
    });

    test("idempotency: a succeeded key replays the stored safe result without running the body", async () => {
      const key = uniq("ec2:us-east-1/i-0abc");
      const idem = uniq("idem");
      let runs = 0;
      const body = async (h: { intent(): Promise<void>; requestId(id: string): void }) => {
        runs++;
        await h.intent();
        h.requestId("req-1");
        return { requestId: "req-1", instanceId: "i-0abc", url: "https://acme.s3.amazonaws.com/x?X-Amz-Signature=abc", sessionToken: "tok", note: "free text" };
      };
      const first = await m.mutate(spec({ keys: [key], idempotencyKey: idem }), body);
      assert.equal(first.result.url, "https://acme.s3.amazonaws.com/x?X-Amz-Signature=abc", "the caller gets the real result");
      const again = await m.mutate(spec({ keys: [key], idempotencyKey: idem }), body);
      assert.equal(runs, 1);
      assert.equal(again.replayed, true);
      assert.equal(again.operationId, first.operationId);
      assert.deepEqual(again.result, { requestId: "req-1", instanceId: "i-0abc" }, "only ids survive into storage");
      assert.deepEqual(again.requestIds, ["req-1"]);
    });

    test("idempotency: running → 409; failed → retried with the old attempt kept; outcome unknown → 409 unless retry-safe", async () => {
      const key = uniq("ec2:us-east-1/i-0def");
      const running = uniq("idem");
      const hold = gate();
      const first = m.mutate(spec({ keys: [key], idempotencyKey: running }), async (h) => {
        await h.intent();
        await hold.p;
        return 1;
      });
      await until(() => mutationState().held.has(key));
      await new Promise((r) => setTimeout(r, 20));
      await assert.rejects(m.mutate(spec({ keys: [key], idempotencyKey: running }), async () => 2), status(409, "in_progress"));
      hold.open();
      await first;

      const failing = uniq("idem");
      await assert.rejects(
        m.mutate(spec({ keys: [key], idempotencyKey: failing }), async (h) => {
          await h.intent();
          throw Object.assign(new Error("Service was not ACTIVE"), { name: "InvalidParameterException" });
        }),
        status(502, "failed"),
      );
      const retried = await m.mutate(spec({ keys: [key], idempotencyKey: failing }), async (h) => {
        await h.intent();
        return "second time";
      });
      assert.equal(retried.result, "second time");
      const rows = await db.all<{ state: string; idempotency_key: string }>("SELECT state, idempotency_key FROM operations WHERE idempotency_key LIKE ? ORDER BY created_at", [`${failing}%`]);
      assert.deepEqual(rows.map((r) => r.state), ["failed", "succeeded"]);
      assert.match(rows[0].idempotency_key, new RegExp(`^${failing}#`));

      const unknown = uniq("idem");
      const lostResponse = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      await assert.rejects(
        m.mutate(spec({ keys: [key], idempotencyKey: unknown }), async (h) => {
          await h.intent();
          throw lostResponse();
        }),
        status(502, "outcome_unknown"),
      );
      await assert.rejects(m.mutate(spec({ keys: [key], idempotencyKey: unknown }), async () => 1), (e) => status(409, "outcome_unknown")(e) && /reconcile first/.test((e as Error).message));
      const safe = await m.mutate(spec({ keys: [key], idempotencyKey: unknown, retrySafe: true }), async (h) => {
        await h.intent();
        return "retried";
      });
      assert.equal(safe.result, "retried");
    });

    test("intent failure: the change is refused with 503 before any side effect, and nothing is recorded", async () => {
      const key = uniq("ecs-service:us-east-1/acme-staging/cart");
      const broken = createMutations({
        db: async () => db,
        audit: async () => {
          throw new Error("disk full");
        },
      });
      let sideEffect = false;
      let operationId = "";
      await assert.rejects(
        broken.mutate(spec({ keys: [key] }), async (h) => {
          operationId = h.operationId;
          await h.intent();
          sideEffect = true;
          return 1;
        }),
        (e) => status(503, "audit_unavailable")(e) && /audit log unavailable/.test((e as Error).message),
      );
      assert.equal(sideEffect, false);
      assert.equal(await op(operationId), undefined, "the operations row rolled back with the failed audit intent");
      assert.deepEqual(await audits(operationId), []);
      assert.equal(Number((await lease(key))?.expires_at), 0, "leases released");
      assert.equal(mutationState().held.has(key), false);
    });

    test("outcome unknown: AWS may have acted → outcome_unknown row, audit 'unknown', 502 that says so", async () => {
      const key = uniq("ecs-service:us-east-1/acme-prod/api");
      const events: MutationEvent[] = [];
      const off = m.onMutation((e) => events.push(e));
      let operationId = "";
      await assert.rejects(
        m.mutate(spec({ keys: [key], env: { id: "production", protected: true, region: "us-east-1" } }), async (h) => {
          operationId = h.operationId;
          await h.intent();
          throw Object.assign(new Error("deadline passed after the request was sent"), { name: "OutcomeUnknownError" });
        }),
        (e) => status(502, "outcome_unknown")(e) && /outcome unknown — check the resource before retrying/.test((e as Error).message),
      );
      off();
      const row = await op(operationId);
      assert.equal(row?.state, "outcome_unknown");
      assert.match(String(row?.error), /outcome unknown/);
      assert.ok(row?.finished_at);
      const a = await audits(operationId);
      assert.deepEqual(a.map((x) => [x.phase, x.result]), [["intent", null], ["result", "unknown"]]);
      assert.equal(a[0].region, "us-east-1");
      assert.deepEqual(events.map((e) => [e.operationId, e.state]), [[operationId, "outcome_unknown"]]);
    });

    test("success: operation row, paired audit rows, safe summary, event after release", async () => {
      const key = uniq("ecs-service:us-east-1/acme-staging/web");
      const events: MutationEvent[] = [];
      const off = m.onMutation((e) => {
        events.push(e);
        assert.equal(mutationState().held.has(key), false, "listeners run after the locks are released");
        throw new Error("a broken listener must not break the change");
      });
      const r = await m.mutate(
        spec({ keys: [key], reason: "deploy fix", params: { desiredBefore: 2, apiToken: "secret-value", link: "https://x.example/a?sig=1" }, inputHash: "sha256:in", planHash: "sha256:plan" }),
        async (h) => {
          await h.intent({ observedRevision: "web:7" });
          h.requestId("req-a");
          h.requestId("req-b");
          return { service: "web", desired: 3, presigned: "https://b.s3.amazonaws.com/o?X-Amz-Signature=zz" };
        },
      );
      off();
      const row = (await op(r.operationId))!;
      assert.equal(row.state, "succeeded");
      assert.equal(row.actor, "alice@acme.example");
      assert.equal(row.actor_kind, "person");
      assert.equal(row.user_id, "u-alice");
      assert.equal(row.env, "staging");
      assert.equal(row.region, "us-east-1");
      assert.equal(row.input_hash, "sha256:in");
      assert.equal(row.plan_hash, "sha256:plan");
      assert.deepEqual(JSON.parse(row.targets), { target: "api", keys: [key] });
      assert.deepEqual(JSON.parse(row.params!), { desiredBefore: 2, apiToken: "***", observedRevision: "web:7" }, "secrets masked, URL with a query dropped");
      assert.deepEqual(JSON.parse(row.request_ids!), ["req-a", "req-b"]);
      assert.deepEqual(JSON.parse(row.result!), { service: "web", desired: 3 });
      assert.ok(Number(row.fence) >= 1);
      const a = await audits(r.operationId);
      assert.deepEqual(a.map((x) => [x.phase, x.result, x.detail]), [["intent", null, null], ["result", "ok", "req-a, req-b"]]);
      assert.equal(events.length, 1);
      assert.equal(events[0].state, "succeeded");
      assert.equal(events[0].reason, "deploy fix");
    });

    test("refusals: a body that throws before intent() leaves no rows and its error is rethrown; returning without intent() is a 500", async () => {
      const key = uniq("ecs-service:us-east-1/acme-staging/search");
      let id = "";
      const stale = new HttpError(409, "the live revision changed since you looked — reload");
      await assert.rejects(
        m.mutate(spec({ keys: [key] }), async (h) => {
          id = h.operationId;
          throw stale;
        }),
        (e) => e === stale,
      );
      assert.equal(await op(id), undefined);
      assert.deepEqual(await audits(id), []);
      const logged: string[] = [];
      const quiet = createMutations({ db: async () => db, log: (event) => logged.push(event) });
      await assert.rejects(
        quiet.mutate(spec({ keys: [key] }), async (h) => {
          id = h.operationId;
          return "did something without an audit intent";
        }),
        status(500, "no_intent"),
      );
      assert.deepEqual(logged, ["mutation_without_intent"], "a programming error is logged loudly");
      assert.equal(await op(id), undefined);
      await assert.rejects(
        m.mutate(spec({ keys: [key] }), async (h) => {
          await h.intent();
          await h.intent();
          return 1;
        }),
        /only once/,
      );
      assert.equal(mutationState().held.has(key), false);
    });

    test("boot reconciliation: another boot's running operations → outcome_unknown + audit 'unknown' + leases released", async () => {
      const t = Date.now();
      const crashed = uniq("op");
      const mine = uniq("op");
      const k1 = uniq("ecs-service:us-east-1/acme-staging/orders");
      const k2 = uniq("ec2:us-east-1/i-orphan");
      const insert = (id: string, boot: string) =>
        db.run(
          "INSERT INTO operations (id, action, actor, actor_kind, env, region, targets, state, fence, boot_id, created_at, started_at) VALUES (?, 'services.restart', 'alice@acme.example', 'person', 'staging', 'us-east-1', ?, 'running', 1, ?, ?, ?)",
          [id, JSON.stringify({ target: "orders", keys: [k1] }), boot, t, t],
        );
      await insert(crashed, "previous-boot");
      await insert(mine, "this-boot");
      await db.run("INSERT INTO mutation_locks (key, operation_id, owner, fence, acquired_at, expires_at) VALUES (?, ?, 'previous-boot', 1, ?, ?)", [k1, crashed, t, t + 600_000]);
      // a lease a crashed process took before any intent: no operation row
      await db.run("INSERT INTO mutation_locks (key, operation_id, owner, fence, acquired_at, expires_at) VALUES (?, ?, 'previous-boot', 4, ?, ?)", [k2, uniq("op"), t, t + 600_000]);
      const boot = createMutations({ db: async () => db, bootId: "this-boot", state: newMutationState() });
      assert.equal(await boot.reconcile(), 1);
      const row = (await op(crashed))!;
      assert.equal(row.state, "outcome_unknown");
      assert.equal(row.error, RESTARTED);
      assert.deepEqual((await audits(crashed)).map((a) => [a.phase, a.result, a.detail]), [["result", "unknown", RESTARTED]]);
      assert.equal(Number((await lease(k1))?.expires_at), 0);
      assert.equal(Number((await lease(k2))?.expires_at), 0, "pre-intent orphan released");
      assert.equal((await op(mine))?.state, "running", "this boot's own work is left alone");
      assert.equal(await boot.reconcile(), 0, "idempotent");
      await db.run("UPDATE operations SET state = 'failed' WHERE id = ?", [mine]);
    });

    test("reconciliation leaves a live console's work alone (rolling upgrade): only a lapsed process is given up on", async () => {
      let clock = Date.now();
      const key = uniq("ecs-service:us-east-1/acme-prod/checkout");
      const oldTask = createMutations({ db: async () => db, now: () => clock, state: newMutationState() });
      const hold = gate();
      let operationId = "";
      const inflight = oldTask.mutate(spec({ keys: [key] }), async (h) => {
        operationId = h.operationId;
        await h.intent();
        await hold.p; // UpdateService in flight on the old task
        return "done";
      });
      await until(() => !!operationId);
      await new Promise((r) => setTimeout(r, 20));
      // The new task boots while the old one is still serving.
      const newTask = createMutations({ db: async () => db, now: () => clock, state: newMutationState() });
      assert.equal(await newTask.reconcile(), 0, "the old task is alive: its change is not lost");
      assert.equal((await op(operationId))?.state, "running");
      assert.ok(Number((await lease(key))?.expires_at) > clock, "and its lease still holds");
      await assert.rejects(newTask.mutate(spec({ keys: [key], actor: bob }), async () => 1), status(409, "busy"));
      hold.open();
      assert.equal((await inflight).result, "done");
      assert.equal((await op(operationId))?.state, "succeeded");

      // A process that stops renewing its row (crashed) is given up on once the row lapses.
      const crashedState = newMutationState();
      const crashed = createMutations({ db: async () => db, now: () => clock, state: crashedState });
      const stuck = gate();
      let lostId = "";
      void crashed
        .mutate(spec({ keys: [key] }), async (h) => {
          lostId = h.operationId;
          await h.intent();
          await stuck.p;
          return 1;
        })
        .catch(() => {});
      await until(() => !!lostId);
      await new Promise((r) => setTimeout(r, 20));
      for (const b of crashedState.beats.get(crashedState.bootId) ?? []) clearInterval(b.timer); // the process dies
      assert.equal(await newTask.reconcile(), 0, "not yet: its row hasn't lapsed");
      clock += PROCESS_TTL_MS + 1;
      assert.equal(await newTask.reconcile(), 1);
      assert.equal((await op(lostId))?.state, "outcome_unknown");
      assert.equal(Number((await lease(key))?.expires_at), 0, "its lease is released");
      stuck.open();
    });

    test("drain releases this process's row, so the next console reconciles at once", async () => {
      const st = newMutationState();
      const own = createMutations({ db: async () => db, state: st });
      await own.mutate(spec({ keys: [uniq("k")] }), async (h) => (await h.intent(), 1));
      const row = () => db.get<{ expires_at: number }>("SELECT expires_at FROM mutation_locks WHERE key = ?", [PROCESS_KEY(st.bootId)]);
      assert.ok(Number((await row())?.expires_at) > Date.now(), "registered as alive by its first change");
      await own.drain(1_000);
      assert.equal(Number((await row())?.expires_at), 0);
      assert.equal(st.beats.size, 0, "heartbeat stopped");
    });

    test("intent() inside the body's own transaction is refused (it would commit or roll back with it)", async () => {
      const key = uniq("ecs-service:us-east-1/acme-staging/tx");
      let operationId = "";
      await assert.rejects(
        m.mutate(spec({ keys: [key] }), async (h) => {
          operationId = h.operationId;
          return db.tx(async () => {
            await h.intent();
            return 1;
          });
        }),
        /inside a database transaction/,
      );
      assert.equal(await op(operationId), undefined);
      assert.equal(mutationState().held.has(key), false);
      // An intent the body forgot to await, which then fails, surfaces as that failure (503), not a missing intent.
      const broken = createMutations({ db: async () => db, audit: async () => Promise.reject(new Error("disk full")), log: () => {} });
      await assert.rejects(
        broken.mutate(spec({ keys: [uniq("k")] }), async (h) => {
          void h.intent().catch(() => {});
          return 1;
        }),
        status(503, "audit_unavailable"),
      );
    });

    test("operation records: safe fields only; markVerified records the verified outcome", async () => {
      const key = uniq("ecs-service:us-east-1/acme-staging/api2");
      const runId = uniq("run");
      const r = await m.runWithMutationContext({ runId, stepId: "step-1", grantId: "grant-1" }, () =>
        m.mutate(spec({ keys: [key], params: { password: "x" } }), async (h) => {
          await h.intent();
          return { requestId: "r" };
        }),
      );
      const v = (await m.getOperation(r.operationId))!;
      assert.deepEqual(Object.keys(v).filter((k) => v[k as keyof typeof v] !== undefined).sort(), ["action", "actorDisplay", "createdAt", "env", "finishedAt", "id", "region", "state", "target"].sort());
      assert.equal(v.state, "succeeded");
      assert.equal(v.target, "api");
      const listed = await m.listOperations({ runId });
      assert.deepEqual(listed.map((x) => x.id), [r.operationId]);
      assert.ok((await m.listOperations({ state: "succeeded", limit: 500 })).some((x) => x.id === r.operationId));
      await m.markVerified(r.operationId, false, "did not stabilise in 15 min");
      const after = (await m.getOperation(r.operationId))!;
      assert.equal(after.verify, "failed");
      assert.equal(after.detail, "did not stabilise in 15 min");
      assert.ok(after.verifiedAt);
      assert.equal(await m.getOperation("nope"), undefined);
    });

    test("runWithMutationContext: run, step and grant ids flow into the record; the step's idempotency key is scoped per change", async () => {
      const k1 = uniq("ecs-service:us-east-1/acme-staging/a");
      const k2 = uniq("ecs-service:us-east-1/acme-staging/b");
      const ctx = { runId: "run-7", stepId: "step-3", grantId: "grant-9", approvalId: "appr-2", idempotencyKey: uniq("step"), planHash: "sha256:p" };
      let runs = 0;
      const body = async (h: { intent(): Promise<void> }) => {
        runs++;
        await h.intent();
        return { id: runs };
      };
      const step = () => m.runWithMutationContext(ctx, async () => [await m.mutate(spec({ keys: [k1] }), body), await m.mutate(spec({ keys: [k2], action: "services.scale" }), body)]);
      const [a, b] = await step();
      assert.notEqual(a.operationId, b.operationId, "two changes in one step are two operations");
      const row = (await op(a.operationId))!;
      assert.deepEqual([row.run_id, row.step_id, row.grant_id, row.approval_id, row.plan_hash], ["run-7", "step-3", "grant-9", "appr-2", "sha256:p"]);
      assert.equal(row.idempotency_key, `${ctx.idempotencyKey}|services.restart|${k1}`);
      const [a2, b2] = await step(); // the worker retries the step
      assert.equal(runs, 2, "a retried step replays both changes");
      assert.deepEqual([a2.replayed, b2.replayed, a2.operationId, b2.operationId], [true, true, a.operationId, b.operationId]);
    });

    test("heartbeat: a long body keeps extending its lease", async () => {
      const key = uniq("ec2:us-east-1/i-long");
      let first = 0;
      await m.mutate(spec({ keys: [key], leaseMs: 90 }), async (h) => {
        first = Number((await lease(key))?.expires_at);
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(Number((await lease(key))?.expires_at) > first, "extended");
        await h.assertOwner();
        await h.intent();
        return 1;
      });
    });

    test("mutate() inside a database transaction is refused (its intent must commit on its own)", async () => {
      await assert.rejects(
        db.tx(async () => m.mutate(spec({ keys: [uniq("k")] }), async () => 1)),
        /inside a database transaction/,
      );
    });

    test("drain: refuses new work with 503 and waits for in-flight work", async () => {
      const own = createMutations({ db: async () => db, state: newMutationState() });
      const hold = gate();
      let finished = false;
      const inflight = own.mutate(spec({ keys: [uniq("k")] }), async (h) => {
        await h.intent();
        await hold.p;
        finished = true;
        return 1;
      });
      await new Promise((r) => setTimeout(r, 20));
      let drained = false;
      const d = own.drain(5_000).then(() => (drained = true));
      assert.equal(own.isDraining(), true);
      await assert.rejects(own.mutate(spec({ keys: [uniq("k")] }), async () => 1), status(503, "draining"));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(drained, false, "still waiting for the change in flight");
      hold.open();
      await d;
      assert.equal(finished, true);
      await inflight;
      // and gives up waiting after the timeout
      const stuck = createMutations({ db: async () => db, state: newMutationState() });
      const never = gate();
      const p = stuck.mutate(spec({ keys: [uniq("k")] }), async (h) => {
        await h.intent();
        await never.p;
        return 1;
      });
      await new Promise((r) => setTimeout(r, 20));
      const t0 = Date.now();
      await stuck.drain(50);
      assert.ok(Date.now() - t0 < 1000);
      never.open();
      await p;
    });

    test("two module instances (separate bundles) share one state on globalThis and contend on the same key", async () => {
      const path = "./mutation-core.ts";
      const a = (await import(`${path}?a`)) as typeof import("./mutation-core.ts");
      const b = (await import(`${path}?b`)) as typeof import("./mutation-core.ts");
      assert.notEqual(a.createMutations, b.createMutations, "really two module instances");
      assert.equal(a.mutationState(), b.mutationState());
      assert.equal(a.mutationState(), mutationState());
      const ma = a.createMutations({ db: async () => db });
      const mb = b.createMutations({ db: async () => db });
      const key = uniq("ecs-service:us-east-1/acme-staging/shared");
      const hold = gate();
      const first = ma.mutate(spec({ keys: [key], action: "services.restart" }), async (h) => {
        await h.intent();
        await hold.p;
        return 1;
      });
      await until(() => mutationState().held.has(key));
      await assert.rejects(mb.mutate(spec({ keys: [key], actor: bob, action: "vars.edit" }), async () => 2), (e: unknown) => (e as { status?: number }).status === 409 && /services\.restart by alice/.test(String((e as Error).message)));
      hold.open();
      await first;
    });
  });
}

test("safe summaries keep ids, versions and sizes; drop presigned URLs and secret-looking fields", () => {
  assert.deepEqual(safeSummary("req-123"), { value: "req-123" });
  assert.deepEqual(
    safeSummary({ requestId: "r", taskDefinition: "arn:x:1", sizeBytes: 12, versionId: "v3", url: "https://b.s3.amazonaws.com/k?X-Amz-Signature=1", body: "contents", secretValue: "s", nested: { instanceIds: ["i-1", "i-2"], token: "t" } }),
    { requestId: "r", taskDefinition: "arn:x:1", sizeBytes: 12, versionId: "v3", nested: { instanceIds: ["i-1", "i-2"] } },
  );
  assert.equal(safeSummary(undefined), undefined);
  assert.equal(safeSummary("https://x.example/download?token=abc"), undefined);
  assert.deepEqual(scrub({ url: "postgres://app:hunter2@db.internal:5432/orders", plain: "postgres://db.internal/orders" }), { plain: "postgres://db.internal/orders" }, "a URL with a password is dropped");
  assert.deepEqual(scrub({ password: "p", clientSecret: "s", secretArn: "arn:aws:secretsmanager:…", list: ["a", "https://u.example/?q=1"], deep: { authorization: "Bearer x" } }), {
    password: "***",
    clientSecret: "***",
    secretArn: "arn:aws:secretsmanager:…",
    list: ["a"],
    deep: { authorization: "***" },
  });
});

// The server wrappers (src/lib/server/{db,audit,mutations,operations}.ts import "server-only", which resolves only under
// the react-server condition): run them end to end in a child process, on SQLite and — with PG_TEST_URL — Postgres.
const url = (f: string) => JSON.stringify(new URL(f, import.meta.url).href);
const scenario = `
const { mutate, onMutation } = await import(${url("./server/mutations.ts")});
const { reconcileOnBoot, listOperations, getOperation, markVerified } = await import(${url("./server/operations.ts")});
const { readAudit } = await import(${url("./server/audit.ts")});
const { getDb } = await import(${url("./server/db.ts")});
const { OutcomeUnknownError } = await import(${url("./server/errors.ts")});
const { canonicalKey } = await import(${url("./mutation-keys.ts")});
const out = {};
const db = await getDb();
out.sharedDb = (await globalThis.__consoleDb) === db && (await getDb()) === db;
out.inTx = await db.tx(async (tx) => (await getDb()) === tx);
out.refusedInTx = await db.tx(async () =>
  mutate({ action: "x", actor: { display: "a", kind: "person" }, target: "t", keys: ["console:t"], params: {} }, async (h) => (await h.intent(), 1)).then(() => "ran", (e) => e.message),
);
const key = canonicalKey({ ecsService: { region: "us-east-1", cluster: "acme-staging", service: "api" } });
const actor = { display: "alice@acme.example", kind: "person" };
const env = { id: "staging", protected: false, region: "us-east-1" };
const events = [];
onMutation((e) => events.push(e.state));
const ok = await mutate({ action: "services.restart", actor, env, target: "api", keys: [key], params: {} }, async (h) => {
  await h.intent();
  h.requestId("req-1");
  return { requestId: "req-1" };
});
try {
  await mutate({ action: "services.scale", actor, env, target: "api", keys: [key], params: {} }, async (h) => {
    await h.intent();
    throw new OutcomeUnknownError(undefined, { requestId: "req-2" });
  });
} catch (e) {
  out.unknown = { status: e.status, code: e.code, operationId: !!e.operationId };
}
out.ops = (await listOperations({})).map((o) => [o.action, o.state]).sort();
const t = Date.now();
await db.run("INSERT INTO operations (id, action, actor, actor_kind, targets, state, boot_id, created_at) VALUES ('crashed', 'services.stop', 'bob@acme.example', 'person', '{\\"target\\":\\"worker\\"}', 'running', 'previous-boot', ?)", [t]);
out.reconciled = await reconcileOnBoot();
out.crashed = (await getOperation("crashed"))?.state;
out.audit = (await readAudit(10)).map((a) => [a.action, a.phase, a.result ?? null, !!a.operationId, a.region ?? null]).sort();
await markVerified(ok.operationId, true);
out.verified = (await getOperation(ok.operationId))?.verify;
out.events = events;
// Defence in depth: inside an agent's call a change runs only in that agent's own mutation context (invoke() sets it).
const { withAgentContext } = await import(${url("./server/agents/principals.ts")});
const { runWithMutationContext } = await import(${url("./server/mutations.ts")});
const agent = { id: "agent:r1", kind: "agent", runId: "r1", delegatorId: "u1", delegatorEmail: "alice@acme.example", policyHash: "h", mode: "bounded-act" };
const change = (n) => mutate({ action: "services.restart", actor: { display: "agent run r1", kind: "agent" }, env, target: "api", keys: [key + ":" + n], params: {} }, async (h) => (await h.intent(), n)).then((r) => r.result, (e) => [e.status, e.code]);
out.agentGuard = await withAgentContext(agent, async () => [
  await change("bypass"),
  await runWithMutationContext({ kind: "agent", runId: "r2", via: "agent" }, () => change("other-run")),
  await runWithMutationContext({ kind: "agent", runId: "r1", via: "agent" }, () => change("own")),
]);
out.afterCall = await change("after");
await db.close?.();
console.log(JSON.stringify(out));
`;

for (const [dialect, fresh] of dialects) {
  test(`server wrappers end to end on ${dialect}: getDb on globalThis, writeAudit/readAudit, mutate, reconcileOnBoot`, async () => {
    const f = dialect === "postgres" ? await fresh() : undefined;
    const envVars: NodeJS.ProcessEnv = { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", NODE_NO_WARNINGS: "1" };
    delete envVars.DATABASE_URL;
    if (f?.url) envVars.DATABASE_URL = f.url;
    const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", env: envVars, timeout: 60_000 });
    const o = JSON.parse(raw.trim().split("\n").pop()!);
    assert.equal(o.sharedDb, true);
    assert.equal(o.inTx, true, "getDb() inside a transaction is that transaction");
    assert.match(o.refusedInTx, /inside a database transaction/);
    assert.deepEqual(o.unknown, { status: 502, code: "outcome_unknown", operationId: true }, "errors.ts' OutcomeUnknownError is recognised");
    assert.deepEqual(o.audit, [
      ["services.restart", "intent", null, true, "us-east-1"],
      ["services.restart", "result", "ok", true, "us-east-1"],
      ["services.scale", "intent", null, true, "us-east-1"],
      ["services.scale", "result", "unknown", true, "us-east-1"],
      ["services.stop", "result", "unknown", true, null],
    ].sort());
    assert.deepEqual(o.ops, [["services.restart", "succeeded"], ["services.scale", "outcome_unknown"]]);
    assert.equal(o.reconciled, 1);
    assert.equal(o.crashed, "outcome_unknown");
    assert.equal(o.verified, "verified");
    assert.deepEqual(o.events.slice(0, 2), ["succeeded", "outcome_unknown"]);
    assert.deepEqual(o.agentGuard, [[500, "agent_bypass"], [500, "agent_bypass"], "own"], "inside an agent's call, only its own mutation context may change anything");
    assert.equal(o.afterCall, "after", "the guard ends with the agent's call");
  });
}
