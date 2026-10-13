// Persisted events with a replay cursor (master plan §3.4, §6 C2 item 5). publish() inserts a row into `events` (its
// `seq` is the SSE id) and nudges in-process listeners; the stream (src/app/api/events/route.ts) reads rows back in
// seq order, so a client that reconnects with its last id misses nothing from the last hour. Integration
// notifications for agent events go through the outbox (./outbox.ts), never from here.
//
// Listeners live on globalThis.__consoleAgentEvents: routes, the proxy and the worker (instrumentation bundle) load
// separate copies of this module. Events are kept 7 days (pruned at most hourly by the worker loop).
import "server-only";
import { KEEP_EVENTS_MS, REPLAY_LIMIT, isEventType, type Audience, type PersistedEventType } from "../../agents/events-cursor.ts";
import type { EventRow } from "../../agents/records.ts";
import { getDb, type Db } from "../db.ts";
import { errText } from "../errors.ts";

export type { Audience, PersistedEventType } from "../../agents/events-cursor.ts";

export interface PublishOptions {
  runId?: string | null;
  audience?: Audience; // default: people only
  topic?: string;
  actor?: string;
  db?: Db; // publish inside the caller's transaction (the row commits or rolls back with its change)
}

interface EventState {
  listeners: Set<(e: { seq: number; type: string; runId: string | null }) => void>;
  prunedAt: number;
}
const g = globalThis as { __consoleAgentEvents?: EventState };
const st = (g.__consoleAgentEvents ??= { listeners: new Set(), prunedAt: 0 });

const MAX_PAYLOAD = 64 * 1024;

export async function publish(type: PersistedEventType, payload: unknown, o: PublishOptions = {}): Promise<number> {
  if (!isEventType(type)) throw new Error(`unknown event type ${String(type)}`);
  let text = JSON.stringify(payload ?? null) ?? "null";
  if (text.length > MAX_PAYLOAD) text = JSON.stringify({ truncated: true, bytes: text.length });
  const db = o.db ?? (await getDb());
  const row = await db.get<{ seq: number | string }>(
    "INSERT INTO events (at, type, topic, run_id, actor, audience, payload) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
    [Date.now(), type, o.topic?.slice(0, 200) ?? null, o.runId ?? null, o.actor?.slice(0, 254) ?? null, JSON.stringify(o.audience ?? { people: true }), text],
  );
  const seq = Number(row?.seq ?? 0);
  const fire = () => {
    for (const f of [...st.listeners]) {
      try {
        f({ seq, type, runId: o.runId ?? null });
      } catch {
        /* a closed stream must never break the publisher */
      }
    }
  };
  // Inside a transaction the row isn't visible to readers until it commits: tell listeners on the next tick (a
  // rolled-back event is then simply not found, and the 2 s poll catches anything else).
  if (o.db) setTimeout(fire, 0).unref?.();
  else fire();
  return seq;
}

// Never throws (a lost event must not undo the change it describes); logs instead.
export function publishSafe(type: PersistedEventType, payload: unknown, o: PublishOptions = {}): void {
  publish(type, payload, o).catch((e) => console.error(JSON.stringify({ level: 40, msg: "event publish failed", type, err: errText(e) })));
}

export interface ReadFilter {
  runId?: string;
  since?: number; // at ≥ since (ms)
  limit?: number;
}

// Events with seq > `seq`, oldest first. The caller filters by audience (visibleTo).
export async function readSince(seq: number, f: ReadFilter = {}): Promise<EventRow[]> {
  const where = ["seq > ?"];
  const args: unknown[] = [seq];
  if (f.runId) {
    where.push("run_id = ?");
    args.push(f.runId);
  }
  if (f.since) {
    where.push("at >= ?");
    args.push(f.since);
  }
  args.push(Math.min(Math.max(f.limit ?? REPLAY_LIMIT, 1), 2_000));
  const rows = await (await getDb()).all<EventRow>(`SELECT seq, at, type, topic, run_id, actor, audience, payload FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`, args);
  return rows.map((r) => ({ ...r, seq: Number(r.seq), at: Number(r.at) }));
}

export async function latestSeq(): Promise<number> {
  const r = await (await getDb()).get<{ seq: number | string | null }>("SELECT MAX(seq) AS seq FROM events");
  return Number(r?.seq ?? 0);
}

// In-process nudge: something was published (the stream then reads it back in order). Never throws; unsubscribes.
export function onEvent(f: (e: { seq: number; type: string; runId: string | null }) => void): () => void {
  st.listeners.add(f);
  return () => void st.listeners.delete(f);
}

// Hourly at most: events older than 7 days, and outbox rows that were delivered (or gave up) more than 14 days ago.
export async function pruneEvents(now = Date.now()): Promise<number> {
  if (now - st.prunedAt < 3_600_000) return 0;
  st.prunedAt = now;
  const db = await getDb();
  await db.run("DELETE FROM outbox WHERE state IN ('delivered', 'dead') AND created_at < ?", [now - 2 * KEEP_EVENTS_MS]);
  return db.run("DELETE FROM events WHERE at < ?", [now - KEEP_EVENTS_MS]);
}
