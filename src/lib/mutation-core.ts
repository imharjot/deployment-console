// The one mutation coordinator (REVIEW R04, R07, R10, "durable operations"; F31, F67). Everything that changes the
// world — console actions, map actions, variable saves, provisioning, CI re-runs, integration writes and agent steps
// — goes through mutate(). Pure: the database, clock, audit writer and boot id are injected, so `node --test` runs it
// against in-memory SQLite and real Postgres. src/lib/server/mutations.ts wires it to the console DB.
//
// mutate(spec, body), in order:
//   1. refuse with 503 while draining;
//   2. honour the idempotency key (succeeded → the stored safe result; running → 409; outcome unknown → 409);
//   3. take an in-process mutex per canonical key, all or nothing in one tick — a busy key fails fast with 409 naming
//      the action and actor that hold it (no waiting, so no deadlock);
//   4. take a fenced DB lease per key (sorted, one transaction): a free or expired row is taken over with fence + 1;
//   5. run the body. It reads state *under the lock*, then calls h.intent(), which commits the operations row and the
//      audit intent in one transaction (or throws 503) — only then may it touch AWS;
//   6. record succeeded / failed / outcome_unknown with a safe summary and the audit result;
//   7. heartbeat the leases every leaseMs/3 while running; h.assertOwner() re-checks the fence;
//   8. release the leases (fenced, so a stale owner can't free a successor's lease), then emit onMutation.
// A body that throws before intent() is a refusal: no rows, the error is rethrown. One that returns without intent()
// is a programming error (500).
//
// Each process also keeps a short "process:<boot id>" row alive in mutation_locks while it may have changes in flight.
// reconcile() only gives up on the operations and leases of processes whose row has lapsed (crashed: within
// PROCESS_TTL_MS; drained: at once), so a console booting next to a live one — an ECS rolling upgrade runs both for a
// while — never declares the other's changes lost or frees the resources they hold.
//
// Every piece of in-process state (key mutexes, draining flag, boot id, process heartbeats, the mutation-context
// AsyncLocalStorage, listeners) lives on globalThis.__consoleMutations: routes and the instrumentation bundle (sampler, agent worker)
// load separate copies of this module, and they must contend on the same keys.
import { AsyncLocalStorage } from "node:async_hooks";
import { inTransaction, insertAudit, type AuditRecord, type Db } from "./db-core.ts";
import { canonicalRegion } from "./mutation-keys.ts";
import { HttpError, errText } from "./server/errors.ts";
import type { OperationView } from "./types.ts";

export interface MutationActor {
  display: string; // what the audit log shows: an email, "token ci-bot (alice@acme.example)", "agent run r_…"
  kind: "person" | "token" | "agent" | "system";
  userId?: string;
  tokenId?: string;
  runId?: string;
  stepId?: string;
  grantId?: string;
  approvalId?: string;
  via?: string;
  ip?: string;
}

export interface MutationSpec {
  action: string; // "services.restart", "ecs-image.deploy-image", "vars.edit", …
  actor: MutationActor;
  env?: { id: string; label?: string; protected: boolean; region?: string };
  target: string; // display name of what changes
  keys: string[]; // canonical keys (src/lib/mutation-keys.ts): every resource and backing object the change touches
  reason?: string;
  params: Record<string, unknown>; // audited (secret-looking fields masked, signed URLs dropped)
  idempotencyKey?: string;
  inputHash?: string;
  planHash?: string;
  leaseMs?: number; // default 10 min, heartbeated every leaseMs/3
  retrySafe?: boolean; // F31: a retry can't duplicate the effect, so an unknown previous outcome doesn't block it
  summarize?: (result: unknown) => Record<string, unknown>; // what may be stored and replayed instead of the raw result
}

export interface MutationHandle {
  operationId: string;
  fences: Record<string, number>;
  // Exactly once, after reading state under the lock and before the first side effect. Commits the operations row
  // and the audit intent together; throws 503 when that's impossible and 409 when the lease was lost.
  intent(extra?: Record<string, unknown>): Promise<void>;
  requestId(id: string): void; // a provider request id, kept on the operation
  assertOwner(): Promise<void>; // throws 409 when another owner has taken a lease over
}

export interface MutationEvent {
  operationId: string;
  action: string;
  target: string;
  env?: MutationSpec["env"];
  actor: MutationActor;
  state: "succeeded" | "failed" | "outcome_unknown";
  detail?: string;
  reason?: string;
  at: number;
}

export interface MutationResult<T> {
  operationId: string;
  result: T; // on an idempotent replay: the stored safe summary, not the original result
  requestIds: string[];
  replayed?: boolean;
}

export type MutationContext = Partial<MutationActor> & { idempotencyKey?: string; planHash?: string };

// The safe fields of an operation (what listOperations / getOperation return and agents may read): src/lib/types.ts.
export type { OperationView };
export type OperationState = OperationView["state"];

export interface OperationRow {
  id: string;
  idempotency_key: string | null;
  action: string;
  actor: string;
  actor_kind: string;
  user_id: string | null;
  token_id: string | null;
  run_id: string | null;
  step_id: string | null;
  grant_id: string | null;
  approval_id: string | null;
  env: string | null;
  region: string | null;
  targets: string; // JSON { target, keys }
  input_hash: string | null;
  plan_hash: string | null;
  params: string | null; // masked JSON
  state: OperationState;
  request_ids: string | null; // JSON string[]
  result: string | null; // safe JSON
  error: string | null;
  fence: number;
  boot_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  verify: string | null;
  verified_at: number | null;
}

export type MutationErrorKind = "busy" | "draining" | "in_progress" | "outcome_unknown" | "unavailable" | "audit_unavailable" | "lost_lease" | "failed" | "no_intent";

export class MutationError extends HttpError {
  kind: MutationErrorKind;
  constructor(status: number, kind: MutationErrorKind, message: string, operationId?: string, retryAfterMs?: number) {
    super(status, message, retryAfterMs);
    this.kind = kind;
    this.code = kind;
    this.operationId = operationId;
  }
}

// ---------- shared state ----------

interface Holder {
  operationId: string;
  action: string;
  actor: string;
  since: number;
}

export interface MutationState {
  held: Map<string, Holder>;
  draining: boolean;
  inflight: Set<Promise<unknown>>;
  listeners: ((e: MutationEvent) => void)[];
  bootId: string;
  context: AsyncLocalStorage<MutationContext>;
  beats: Map<string, ProcessBeat[]>; // process liveness rows kept alive, per boot id (one per database)
}

interface ProcessBeat {
  db: Db;
  timer: ReturnType<typeof setInterval>;
  ready: Promise<void>;
}

export const newMutationState = (): MutationState => ({
  held: new Map(),
  draining: false,
  inflight: new Set(),
  listeners: [],
  bootId: crypto.randomUUID(),
  context: new AsyncLocalStorage<MutationContext>(),
  beats: new Map(),
});

// The process-wide state, created by whichever bundle gets here first. Fields are filled one by one so a newer copy
// of this module (dev hot reload) can add one without dropping the locks an older copy holds.
export function mutationState(): MutationState {
  const g = globalThis as { __consoleMutations?: Partial<MutationState> };
  const s = (g.__consoleMutations ??= {});
  const fresh = newMutationState();
  s.held ??= fresh.held;
  s.draining ??= false;
  s.inflight ??= fresh.inflight;
  s.listeners ??= fresh.listeners;
  s.bootId ??= fresh.bootId;
  s.context ??= fresh.context;
  s.beats ??= fresh.beats;
  return s as MutationState;
}

// ---------- safe summaries ----------

// Strings that must never be stored or shown: presigned URLs, any URL carrying a query string, and URLs with a password
// in them ("postgres://app:pw@db…").
export const unsafeString = (s: string) =>
  /X-Amz-Signature/i.test(s) || /https?:\/\/[^\s?#]*\?/i.test(s) || /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]*@/i.test(s);
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const SECRET_NAME = /(secret|password|passwd|passphrase|token|credential|credentials|privatekey|apikey|accesskey|secretkey|authorization|cookie|signature)s?$/;
const ID_NAME = /(id|ids|arn|arns|version|versions|revision|size|bytes|length|count|etag|digest|sha|status|state|name|key|desired|taskdefinition|service|cluster|image|region|env)$/;

const safePrimitive = (v: unknown): string | number | boolean | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return unsafeString(v) ? undefined : v.slice(0, 300);
  return undefined;
};

// Default summary of a body's result: ids, versions and sizes only.
export function safeSummary(result: unknown, depth = 0): Record<string, unknown> | undefined {
  if (result === null || result === undefined) return undefined;
  const p = safePrimitive(result);
  if (p !== undefined) return depth === 0 ? { value: p } : undefined;
  if (typeof result !== "object" || Array.isArray(result) || depth > 1) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    const n = norm(k);
    if (SECRET_NAME.test(n)) continue;
    if (Array.isArray(v)) {
      if (!ID_NAME.test(n)) continue;
      const items = v.slice(0, 20).map(safePrimitive).filter((x) => x !== undefined);
      if (items.length) out[k] = items;
    } else if (v && typeof v === "object") {
      const inner = safeSummary(v, depth + 1);
      if (inner && Object.keys(inner).length) out[k] = inner;
    } else if (ID_NAME.test(n)) {
      const s = safePrimitive(v);
      if (s !== undefined) out[k] = s;
    }
  }
  return out;
}

// Any summary or params object, made safe to store: secret-looking fields masked, signed URLs dropped, bounded.
export function scrub(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return unsafeString(v) ? undefined : v.length > 500 ? `${v.slice(0, 500)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (depth > 4) return undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_NAME.test(norm(k))) {
        if (x !== undefined && x !== null && x !== "") out[k] = "***";
        continue;
      }
      const s = scrub(x, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

const capJson = (v: unknown, max = 8000) => {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s === undefined ? null : s.length <= max ? s : JSON.stringify({ truncated: true, size: s.length });
};

function parseJson<T>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

// Default classifier for "AWS may have done it": a lost response after the request left. src/lib/server/errors.ts'
// isOutcomeUnknown is injected by the server wrapper; this keeps the core usable on its own.
export function looksOutcomeUnknown(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string; outcomeUnknown?: boolean; afterSend?: boolean } | undefined;
  if (!err || typeof err !== "object") return false;
  if (err.name === "OutcomeUnknownError" || err.outcomeUnknown === true) return true;
  if ((err.name === "AbortError" || err.name === "TimeoutError") && err.afterSend === true) return true;
  return err.code === "ECONNRESET" || /socket hang up/i.test(String(err.message ?? ""));
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505" || /UNIQUE constraint failed/i.test(String((e as Error)?.message));

// ---------- the coordinator ----------

export interface MutationDeps {
  db(): Promise<Db>;
  now?(): number;
  audit?(e: AuditRecord, db: Db): Promise<void>; // must write through the db it is given (the intent's transaction)
  bootId?: string; // default: the process-wide boot id
  outcomeUnknown?(e: unknown): boolean;
  newId?(): string;
  state?: MutationState; // default: the globalThis state (tests pass a fresh one to play another process)
  log?(event: string, data: Record<string, unknown>): void;
  // Refuses a change before anything else happens (it throws), given the mutation context the change would run in:
  // the console uses it to refuse agent code that changes resources without going through invoke() as the agent.
  guard?(ctx: MutationContext | undefined): void;
}

export const DEFAULT_LEASE_MS = 10 * 60_000;
export const PROCESS_TTL_MS = 90_000; // a process row not renewed for this long belongs to a stopped console (renewed every TTL/3)
export const PROCESS_KEY = (bootId: string) => `process:${bootId}`;
export const RESTARTED = "console restarted while this was in flight — check the resource before retrying";
const UNKNOWN = "outcome unknown — check the resource before retrying";

const LEASE_SQL = `INSERT INTO mutation_locks (key, operation_id, owner, fence, acquired_at, expires_at) VALUES (?, ?, ?, 1, ?, ?)
  ON CONFLICT (key) DO UPDATE SET operation_id = excluded.operation_id, owner = excluded.owner, fence = mutation_locks.fence + 1,
    acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
  WHERE mutation_locks.expires_at < ? RETURNING fence`;

const PROCESS_SQL = `INSERT INTO mutation_locks (key, operation_id, owner, fence, acquired_at, expires_at) VALUES (?, NULL, ?, 0, ?, ?)
  ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at`;
// The process that wrote boot id X is alive while its row is (SQL fragment; `?` = now).
const ALIVE = (bootColumn: string) =>
  `EXISTS (SELECT 1 FROM mutation_locks p WHERE p.key = 'process:' || ${bootColumn} AND p.expires_at > ?)`;

const INSERT_OPERATION = `INSERT INTO operations (id, idempotency_key, action, actor, actor_kind, user_id, token_id, run_id, step_id,
  grant_id, approval_id, env, region, targets, input_hash, plan_hash, params, state, request_ids, fence, boot_id, created_at, started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`;

const CONTEXT_FIELDS = ["userId", "tokenId", "runId", "stepId", "grantId", "approvalId", "via", "ip"] as const;

export function createMutations(deps: MutationDeps) {
  const state = () => deps.state ?? mutationState();
  const now = () => (deps.now ? deps.now() : Date.now());
  const bootId = () => deps.bootId ?? state().bootId;
  const newId = () => (deps.newId ? deps.newId() : crypto.randomUUID());
  const audit = (e: AuditRecord, db: Db) => (deps.audit ? deps.audit(e, db) : insertAudit(db, e));
  const unknownOutcome = (e: unknown) => (deps.outcomeUnknown ?? looksOutcomeUnknown)(e);
  const log =
    deps.log ??
    ((event: string, data: Record<string, unknown>) => console.error(JSON.stringify({ level: "error", source: "deployment-console", component: "mutations", event, ...data })));
  const emit = (e: MutationEvent) => {
    for (const f of state().listeners) {
      try {
        f(e);
      } catch {
        // listeners never break a mutation
      }
    }
  };

  // Registers this process as alive (once per boot id) and keeps it so; see the header. Throws when the first write fails.
  function keepAlive(db: Db): Promise<void> {
    const st = state();
    const boot = bootId();
    const list = st.beats.get(boot) ?? [];
    const have = list.find((b) => b.db === db);
    if (have) return have.ready;
    const beat = () => db.run(PROCESS_SQL, [PROCESS_KEY(boot), boot, now(), now() + PROCESS_TTL_MS]);
    const timer = setInterval(() => void beat().catch((e) => log("process_heartbeat_failed", { bootId: boot, error: errText(e) })), Math.floor(PROCESS_TTL_MS / 3));
    timer.unref?.();
    const entry: ProcessBeat = { db, timer, ready: Promise.resolve() };
    entry.ready = beat().then(
      () => undefined,
      (e) => {
        clearInterval(timer);
        const left = (st.beats.get(boot) ?? []).filter((b) => b !== entry);
        if (left.length) st.beats.set(boot, left);
        else st.beats.delete(boot);
        throw e;
      },
    );
    st.beats.set(boot, [...list, entry]);
    return entry.ready;
  }

  const busy = (target: string, h?: { action: string; actor: string }) =>
    new MutationError(409, "busy", h ? `another change to ${target} is in progress (${h.action} by ${h.actor})` : `another change to ${target} is in progress (on another console process)`);
  const lostLease = (target: string, operationId: string) =>
    new MutationError(409, "lost_lease", `the lock on ${target} was taken over by another change; this one stopped before finishing`, operationId);

  async function openDb(): Promise<Db> {
    let db: Db;
    try {
      db = await deps.db();
    } catch (e) {
      throw new MutationError(503, "unavailable", `the console database is unavailable, change refused: ${errText(e)}`, undefined, 30_000);
    }
    if (inTransaction()) throw new Error("mutate() can't run inside a database transaction: its audit intent must commit on its own");
    return db;
  }

  async function execute<T>(spec: MutationSpec, body: (h: MutationHandle) => Promise<T>): Promise<MutationResult<T>> {
    const st = state();
    const ctx = st.context.getStore();
    const actor: MutationActor = { ...spec.actor };
    if (ctx) for (const k of CONTEXT_FIELDS) if (actor[k] === undefined && ctx[k] !== undefined) actor[k] = ctx[k];
    const keys = [...new Set(spec.keys)].sort();
    // A key from the context belongs to a whole run step, which may make several changes: scope it to this one.
    const idem = spec.idempotencyKey ?? (ctx?.idempotencyKey ? `${ctx.idempotencyKey}|${spec.action}|${keys.join(",")}` : undefined);
    const planHash = spec.planHash ?? ctx?.planHash;
    const leaseMs = Math.max(30, spec.leaseMs ?? DEFAULT_LEASE_MS);
    const db = await openDb();
    const createdAt = now();

    // 2. Idempotency.
    if (idem) {
      let prev: Pick<OperationRow, "id" | "state" | "result" | "request_ids"> | undefined;
      try {
        prev = await db.get("SELECT id, state, result, request_ids FROM operations WHERE idempotency_key = ?", [idem]);
      } catch (e) {
        throw new MutationError(503, "unavailable", `the console database is unavailable, change refused: ${errText(e)}`, undefined, 30_000);
      }
      if (prev?.state === "succeeded") {
        return { operationId: prev.id, result: parseJson<T>(prev.result) as T, requestIds: parseJson<string[]>(prev.request_ids) ?? [], replayed: true };
      }
      if (prev?.state === "running" || prev?.state === "queued") throw new MutationError(409, "in_progress", `this change is already in progress (operation ${prev.id})`, prev.id);
      if (prev?.state === "outcome_unknown" && !spec.retrySafe)
        throw new MutationError(409, "outcome_unknown", `the previous attempt's outcome is unknown — reconcile first: check the resource before retrying (operation ${prev.id})`, prev.id);
      // failed or cancelled (or unknown but retry-safe): a fresh attempt; intent() sets the old row's key aside.
    }

    // 3. In-process mutexes: check every key, then take them all, in one synchronous step.
    const operationId = newId();
    const holder: Holder = { operationId, action: spec.action, actor: actor.display, since: createdAt };
    for (const k of keys) {
      const h = st.held.get(k);
      if (h) throw busy(spec.target, h);
    }
    for (const k of keys) st.held.set(k, holder);

    const region = spec.env?.region ?? keys.map(canonicalRegion).find(Boolean);
    const fences: Record<string, number> = {};
    const requestIds: string[] = [];
    let leased = false;
    let lost = false;
    let stopped = false;
    let beat: ReturnType<typeof setInterval> | undefined;
    let ridWrite: Promise<unknown> = Promise.resolve();
    let event: MutationEvent | undefined;

    // Leases still ours: same fence, not expired. FOR UPDATE (Postgres) serialises with a takeover inside intent().
    const owns = async (d: Db, forUpdate = false) => {
      if (lost) return false;
      if (!keys.length) return true;
      const rows = await d.all<{ key: string; fence: number; expires_at: number }>(
        `SELECT key, fence, expires_at FROM mutation_locks WHERE key IN (${keys.map(() => "?").join(", ")})${forUpdate && d.kind === "postgres" ? " FOR UPDATE" : ""}`,
        keys,
      );
      const t = now();
      const ok = keys.every((k) => rows.some((r) => r.key === k && Number(r.fence) === fences[k] && Number(r.expires_at) > t));
      if (!ok) lost = true;
      return ok;
    };

    const heartbeat = async () => {
      if (lost || stopped) return;
      try {
        await db.tx(async (tx) => {
          for (const k of keys) {
            const n = await tx.run("UPDATE mutation_locks SET expires_at = ? WHERE key = ? AND fence = ? AND expires_at > 0", [now() + leaseMs, k, fences[k]]);
            if (!n) lost = true;
          }
        });
      } catch (e) {
        log("lease_heartbeat_failed", { operationId, error: errText(e) });
      }
    };

    try {
      // 4. DB leases, sorted, all or nothing (this process registered as alive first, for reconcile()).
      try {
        await keepAlive(db);
        await db.tx(async (tx) => {
          const t = now();
          for (const k of keys) {
            const row = await tx.get<{ fence: number }>(LEASE_SQL, [k, operationId, bootId(), t, t + leaseMs, t]);
            if (!row) {
              const h = await tx.get<{ action: string | null; actor: string | null }>(
                "SELECT o.action, o.actor FROM mutation_locks l LEFT JOIN operations o ON o.id = l.operation_id WHERE l.key = ?",
                [k],
              );
              throw busy(spec.target, h?.action ? { action: h.action, actor: h.actor ?? "someone" } : undefined);
            }
            fences[k] = Number(row.fence);
          }
        });
      } catch (e) {
        if (e instanceof MutationError) throw e;
        throw new MutationError(503, "unavailable", `the console database is unavailable, change refused: ${errText(e)}`, undefined, 30_000);
      }
      leased = true;
      if (keys.length) {
        beat = setInterval(() => void heartbeat(), Math.max(10, Math.floor(leaseMs / 3)));
        beat.unref?.();
      }

      // 5. The body, with its handle.
      let intent = "none" as "none" | "pending" | "done" | "failed"; // set from the handle's closures
      let intentDone: Promise<void> | undefined;
      let intentError: unknown;
      const writeIntent = async (extra?: Record<string, unknown>) => {
        const params = scrub({ ...spec.params, ...(extra ?? {}) }) as Record<string, unknown>;
        const startedAt = now();
        try {
          await db.tx(async (tx) => {
            if (!(await owns(tx, true))) throw lostLease(spec.target, operationId);
            if (idem)
              await tx.run(
                `UPDATE operations SET idempotency_key = idempotency_key || '#' || id WHERE idempotency_key = ? AND state IN ('failed', 'cancelled'${spec.retrySafe ? ", 'outcome_unknown'" : ""})`,
                [idem],
              );
            await tx.run(INSERT_OPERATION, [
              operationId, idem, spec.action, actor.display, actor.kind, actor.userId, actor.tokenId, actor.runId, actor.stepId, actor.grantId,
              actor.approvalId, spec.env?.id, region, JSON.stringify({ target: spec.target, keys }), spec.inputHash, planHash, capJson(params),
              JSON.stringify(requestIds), Math.max(0, ...Object.values(fences)), bootId(), createdAt, startedAt,
            ]);
            await audit(
              { at: startedAt, phase: "intent", env: spec.env?.id, target: spec.target, action: spec.action, user: actor.display, ip: actor.ip, reason: spec.reason, params, operationId, region },
              tx,
            );
          });
        } catch (e) {
          if (e instanceof MutationError) throw e;
          if (isUniqueViolation(e)) throw new MutationError(409, "in_progress", "this change is already in progress", operationId);
          throw new MutationError(503, "audit_unavailable", `audit log unavailable, change refused: ${errText(e)}`, operationId, 30_000);
        }
      };
      const h: MutationHandle = {
        operationId,
        fences,
        intent: (extra) => {
          if (intent !== "none") return Promise.reject(new Error("intent() may be called only once per mutation"));
          // Inside the body's own transaction the intent would commit (or roll back) with that transaction, not now.
          if (inTransaction()) return Promise.reject(new Error("intent() can't run inside a database transaction: the operation row and audit intent must commit on their own"));
          intent = "pending";
          intentDone = writeIntent(extra).then(
            () => void (intent = "done"),
            (e) => {
              intent = "failed";
              intentError = e;
              throw e;
            },
          );
          return intentDone;
        },
        requestId: (id) => {
          if (typeof id !== "string" || !id || requestIds.includes(id) || requestIds.length >= 50) return;
          requestIds.push(id.slice(0, 200));
          if (intent === "done") {
            const ids = JSON.stringify(requestIds);
            ridWrite = ridWrite.then(() => db.run("UPDATE operations SET request_ids = ? WHERE id = ?", [ids, operationId])).catch(() => {});
          }
        },
        assertOwner: async () => {
          if (!(await owns(db))) throw lostLease(spec.target, operationId);
        },
      };

      let result: T;
      try {
        result = await body(h);
        if (intent === "pending") await intentDone!.catch(() => {});
      } catch (e) {
        if (intent === "pending") await intentDone!.catch(() => {});
        if (intent !== "done") throw e; // refused before anything was recorded
        // 7. A failure after the intent: either AWS said no, or nobody knows what AWS did.
        const unknown = unknownOutcome(e);
        const detail = unknown ? `${UNKNOWN}: ${errText(e)}` : errText(e);
        await finish(unknown ? "outcome_unknown" : "failed", detail, undefined);
        event = { operationId, action: spec.action, target: spec.target, env: spec.env, actor, state: unknown ? "outcome_unknown" : "failed", detail, reason: spec.reason, at: now() };
        if (unknown) throw new MutationError(502, "outcome_unknown", `${UNKNOWN} (${errText(e)})`, operationId);
        if (e instanceof HttpError) {
          e.operationId = operationId;
          throw e;
        }
        throw new MutationError(502, "failed", errText(e), operationId);
      }
      if (intent === "failed") throw intentError; // an intent the body didn't await: refused, nothing recorded
      if (intent !== "done") {
        log("mutation_without_intent", { operationId, action: spec.action, target: spec.target });
        throw new MutationError(500, "no_intent", `${spec.action} returned without recording an audit intent`, operationId);
      }

      // 6. Success.
      let summary: unknown;
      try {
        summary = scrub(spec.summarize ? spec.summarize(result) : safeSummary(result));
      } catch {
        summary = scrub(safeSummary(result));
      }
      await finish("succeeded", requestIds.join(", ") || undefined, summary);
      event = { operationId, action: spec.action, target: spec.target, env: spec.env, actor, state: "succeeded", detail: requestIds.join(", ") || undefined, reason: spec.reason, at: now() };
      return { operationId, result, requestIds: [...requestIds] };
    } finally {
      // 9. Release: the DB leases first (fenced), then the in-process mutexes; then tell the listeners.
      stopped = true;
      if (beat) clearInterval(beat);
      if (leased && keys.length) {
        try {
          await db.tx(async (tx) => {
            for (const k of keys) await tx.run("UPDATE mutation_locks SET expires_at = 0 WHERE key = ? AND fence = ?", [k, fences[k]]);
          });
        } catch (e) {
          log("lease_release_failed", { operationId, error: errText(e), note: "the leases expire on their own" });
        }
      }
      for (const k of keys) if (st.held.get(k) === holder) st.held.delete(k);
      if (event) emit(event);
    }

    async function finish(stateTo: "succeeded" | "failed" | "outcome_unknown", detail: string | undefined, summary: unknown) {
      await ridWrite;
      const at = now();
      try {
        await db.run(
          "UPDATE operations SET state = ?, result = ?, error = ?, request_ids = ?, finished_at = ? WHERE id = ? AND state IN ('running', 'outcome_unknown')",
          [stateTo, capJson(summary), stateTo === "succeeded" ? null : (detail ?? null), JSON.stringify(requestIds), at, operationId],
        );
      } catch (e) {
        log("operation_finish_failed", { operationId, state: stateTo, error: errText(e) });
      }
      try {
        await audit(
          {
            at, phase: "result", env: spec.env?.id, target: spec.target, action: spec.action, user: actor.display, ip: actor.ip, reason: spec.reason,
            params: {}, result: stateTo === "succeeded" ? "ok" : stateTo === "failed" ? "error" : "unknown", detail: detail?.slice(0, 500), operationId, region,
          },
          db,
        );
      } catch (e) {
        log("audit_result_failed", { operationId, error: errText(e) });
      }
    }
  }

  function mutate<T>(spec: MutationSpec, body: (h: MutationHandle) => Promise<T>): Promise<MutationResult<T>> {
    const st = state();
    try {
      deps.guard?.(st.context.getStore());
    } catch (e) {
      return Promise.reject(e);
    }
    if (st.draining) return Promise.reject(new MutationError(503, "draining", "the console is shutting down — try again in a minute", undefined, 30_000));
    const run = execute(spec, body);
    st.inflight.add(run);
    const done = () => void st.inflight.delete(run);
    run.then(done, done);
    return run;
  }

  function onMutation(f: (e: MutationEvent) => void): () => void {
    const st = state();
    st.listeners.push(f);
    return () => void (st.listeners = st.listeners.filter((x) => x !== f));
  }

  function runWithMutationContext<T>(ctx: MutationContext, fn: () => Promise<T>): Promise<T> {
    const st = state();
    const merged: MutationContext = { ...st.context.getStore() };
    for (const [k, v] of Object.entries(ctx)) if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    return st.context.run(merged, fn);
  }

  // Stop taking new changes and wait (up to timeoutMs) for the ones in flight. Used on SIGTERM.
  async function drain(timeoutMs: number): Promise<void> {
    const st = state();
    st.draining = true;
    const pending = [...st.inflight];
    if (pending.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => {
          timer = setTimeout(r, timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    // This process is about to exit: let the next console reconcile whatever is left at once, not after PROCESS_TTL_MS.
    const boot = bootId();
    const beats = st.beats.get(boot) ?? [];
    st.beats.delete(boot);
    for (const b of beats) {
      clearInterval(b.timer);
      try {
        await b.db.run("UPDATE mutation_locks SET expires_at = 0 WHERE key = ?", [PROCESS_KEY(boot)]);
      } catch (e) {
        log("process_release_failed", { bootId: boot, error: errText(e), note: `other consoles reconcile in ${PROCESS_TTL_MS / 1000} s` });
      }
    }
  }

  const isDraining = () => state().draining;

  // ---------- operation records ----------

  const view = (r: OperationRow): OperationView => {
    const t = parseJson<{ target?: string }>(r.targets);
    const detail = r.error ?? undefined;
    return {
      id: r.id,
      action: r.action,
      target: t?.target ?? "",
      env: r.env ?? undefined,
      region: r.region ?? undefined,
      actorDisplay: r.actor,
      state: r.state,
      verify: r.verify === "verified" || r.verify === "failed" ? r.verify : undefined,
      createdAt: Number(r.created_at),
      finishedAt: r.finished_at == null ? undefined : Number(r.finished_at),
      verifiedAt: r.verified_at == null ? undefined : Number(r.verified_at),
      detail: detail && !unsafeString(detail) ? detail : undefined,
    };
  };

  async function getOperation(id: string): Promise<OperationView | undefined> {
    const r = await (await deps.db()).get<OperationRow>("SELECT * FROM operations WHERE id = ?", [id]);
    return r ? view(r) : undefined;
  }

  async function listOperations(f: { state?: string; runId?: string; limit?: number } = {}): Promise<OperationView[]> {
    const where: string[] = [];
    const p: unknown[] = [];
    if (f.state) {
      where.push("state = ?");
      p.push(f.state);
    }
    if (f.runId) {
      where.push("run_id = ?");
      p.push(f.runId);
    }
    const limit = Math.min(500, Math.max(1, Math.floor(f.limit ?? 50)));
    const rows = await (await deps.db()).all<OperationRow>(
      `SELECT * FROM operations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
      [...p, limit],
    );
    return rows.map(view);
  }

  // "AWS accepted" is not "done": the sampler (or an agent verify step) records whether the change took effect.
  async function markVerified(id: string, ok: boolean, detail?: string): Promise<void> {
    await (await deps.db()).run("UPDATE operations SET verify = ?, verified_at = ?, error = COALESCE(?, error) WHERE id = ?", [
      ok ? "verified" : "failed", now(), ok ? null : (detail?.slice(0, 500) ?? null), id,
    ]);
  }

  // At boot (and then every minute): operations a stopped process left running can't be finished by anyone — their
  // outcome is unknown. Mark them, audit "unknown", release their leases. Leases a stopped process took before any
  // intent (nothing reached AWS) are released too, instead of blocking that resource until they expire. A process is
  // stopped when its "process:<boot id>" row has lapsed (see the header): a console still running next to this one —
  // the old task during an ECS rolling upgrade — keeps its changes and its leases.
  async function reconcile(): Promise<number> {
    const db = await deps.db();
    const boot = bootId();
    await keepAlive(db); // from now on, consoles booting next to this one leave its work alone
    const rows = await db.all<OperationRow>(
      `SELECT * FROM operations WHERE state = 'running' AND (boot_id IS NULL OR boot_id <> ?) AND NOT ${ALIVE("operations.boot_id")}`,
      [boot, now()],
    );
    let n = 0;
    for (const r of rows) {
      const t = now();
      const changed = await db.tx(async (tx) => {
        if (!(await tx.run("UPDATE operations SET state = 'outcome_unknown', finished_at = ?, error = ? WHERE id = ? AND state = 'running'", [t, RESTARTED, r.id]))) return false;
        await tx.run("UPDATE mutation_locks SET expires_at = 0 WHERE operation_id = ?", [r.id]);
        await audit(
          { at: t, phase: "result", env: r.env ?? undefined, target: parseJson<{ target?: string }>(r.targets)?.target ?? "", action: r.action, user: r.actor, params: {}, result: "unknown", detail: RESTARTED, operationId: r.id, region: r.region ?? undefined },
          tx,
        );
        return true;
      });
      if (changed) n++;
    }
    await db.run(
      `UPDATE mutation_locks SET expires_at = 0 WHERE expires_at > 0 AND key NOT LIKE 'process:%' AND (owner IS NULL OR owner <> ?)
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = mutation_locks.operation_id) AND NOT ${ALIVE("mutation_locks.owner")}`,
      [boot, now()],
    );
    // One row per boot: forget the ones lapsed for a day (they carry no fence, unlike resource keys).
    await db.run("DELETE FROM mutation_locks WHERE key LIKE 'process:%' AND expires_at < ?", [now() - 86_400_000]);
    return n;
  }

  return { mutate, onMutation, runWithMutationContext, drain, isDraining, reconcile, getOperation, listOperations, markVerified };
}

export type Mutations = ReturnType<typeof createMutations>;
