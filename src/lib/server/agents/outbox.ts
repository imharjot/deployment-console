// The agent outbox (master plan §6 C2 item 5, AGENT_ARCHITECTURE §4): integration notifications for agent events —
// an approval an agent asks for, a run that finished or failed — are queued as rows in the same transaction as the
// change they describe and delivered later by the worker loop. A delivery that fails is retried with backoff (only for
// the integrations that failed), and never repeats anything the agent did: the outbox sends messages, nothing else.
//
// Rows point at the persisted event (`event_seq`); delivery rebuilds the notification from the current records, so
// nothing secret or stale is stored twice.
import "server-only";
import type { OutboxRow } from "../../agents/records.ts";
import type { ConsoleEvent } from "../../plugins/events.ts";
import { getDb, newId, type Db } from "../db.ts";
import { errText } from "../errors.ts";

export const OUTBOX_MAX_ATTEMPTS = 8;
// 30 s, 1 min, 2 min … capped at 30 min.
export const outboxBackoffMs = (attempts: number) => Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

export async function queueOutbox(db: Db, eventSeq: number, target = "integrations"): Promise<void> {
  await db.run("INSERT INTO outbox (id, event_seq, target, state, attempts, next_at, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)", [
    newId(), eventSeq, target, Date.now(), Date.now(),
  ]);
}

// What a queued event becomes for integrations (undefined: nothing to tell them). Rebuilt at delivery time.
export type OutboxBuilder = (row: { type: string; run_id: string | null; payload: string | null }) => Promise<ConsoleEvent | undefined>;
export type OutboxDeliverer = (e: ConsoleEvent, only?: string) => Promise<{ delivered: string[]; failed: string[] }>;

async function defaultBuilder(row: { type: string; run_id: string | null; payload: string | null }): Promise<ConsoleEvent | undefined> {
  const { consoleUrl } = await import("../events.ts");
  const p = parse(row.payload);
  const db = await getDb();
  if (row.type === "run" && row.run_id && (p.state === "succeeded" || p.state === "failed")) {
    const run = await db.get<{ id: string; title: string | null; kind: string; error: string | null; principal: string | null }>(
      "SELECT id, title, kind, error, principal FROM agent_runs WHERE id = ?",
      [row.run_id],
    );
    if (!run) return undefined;
    const by = parse(run.principal).delegatorEmail;
    return {
      type: p.state === "failed" ? "agent.run_failed" : "agent.run_finished", at: Date.now(), url: consoleUrl(`/automation?run=${encodeURIComponent(run.id)}`),
      runId: run.id, title: run.title ?? `${run.kind} run`, kind: run.kind, by: typeof by === "string" ? by : undefined, error: run.error?.slice(0, 300) ?? undefined,
    };
  }
  if (row.type === "approval" && typeof p.id === "string" && row.run_id) {
    const a = await db.get<{ id: string; op: string; plan: string | null; env: string | null; status: string; expires_at: number | string | null }>(
      "SELECT a.id, a.op, a.plan, a.env, a.status, g.expires_at FROM approvals a LEFT JOIN approval_grants g ON g.id = a.grant_id WHERE a.id = ?",
      [p.id],
    );
    const run = await db.get<{ title: string | null; principal: string | null }>("SELECT title, principal FROM agent_runs WHERE id = ?", [row.run_id]);
    // Decided, invalidated or expired before we got to it: nothing to ask.
    if (!a || a.status !== "pending") return undefined;
    const expiresAt = a.expires_at === null ? undefined : Number(a.expires_at);
    if (expiresAt !== undefined && expiresAt <= Date.now()) return undefined;
    const plan = parse(a.plan);
    return {
      type: "agent.approval_needed", at: Date.now(), url: consoleUrl(`/automation?approval=${encodeURIComponent(a.id)}#approvals`),
      runId: row.run_id, runTitle: run?.title ?? undefined, op: a.op, summary: typeof plan.summary === "string" ? plan.summary.slice(0, 300) : a.op,
      ...(a.env ? { env: a.env, protected: p.protected === true } : {}), approvalId: a.id, requestedFor: String(parse(run?.principal ?? null).delegatorEmail ?? "an agent"),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  return undefined;
}

const parse = (s: string | null | undefined): Record<string, unknown> => {
  try {
    const v = s ? JSON.parse(s) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const defaultDeliverer: OutboxDeliverer = async (e, only) => (await import("../events.ts")).deliverEvent(e, only);

// Delivers due rows (oldest first, a batch at a time). Never throws: a failure stays on its row for the next pass.
export async function deliverOutbox(o: { now?: number; limit?: number; build?: OutboxBuilder; deliver?: OutboxDeliverer } = {}): Promise<{ delivered: number; failed: number }> {
  const now = o.now ?? Date.now();
  const db = await getDb();
  const rows = await db.all<OutboxRow>("SELECT * FROM outbox WHERE state = 'pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY created_at LIMIT ?", [now, o.limit ?? 20]);
  let delivered = 0, failed = 0;
  for (const row of rows) {
    // Claim it (two workers on one database must not both send it).
    const claimUntil = now + 60_000;
    if ((await db.run("UPDATE outbox SET next_at = ? WHERE id = ? AND state = 'pending' AND (next_at IS NULL OR next_at <= ?)", [claimUntil, row.id, now])) !== 1) continue;
    try {
      const ev = row.event_seq === null ? undefined : await db.get<{ type: string; run_id: string | null; payload: string | null }>("SELECT type, run_id, payload FROM events WHERE seq = ?", [row.event_seq]);
      const e = ev ? await (o.build ?? defaultBuilder)(ev) : undefined;
      if (!e) {
        await db.run("UPDATE outbox SET state = 'delivered', delivered_at = ?, last_error = ? WHERE id = ?", [Date.now(), "nothing to send", row.id]);
        continue;
      }
      const only = row.target.startsWith("integration:") ? row.target.slice("integration:".length) : undefined;
      const r = await (o.deliver ?? defaultDeliverer)(e, only);
      if (!r.failed.length) {
        await db.run("UPDATE outbox SET state = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ?", [Date.now(), row.id]);
        delivered++;
        continue;
      }
      failed++;
      const attempts = Number(row.attempts) + 1;
      if (only) {
        await db.run("UPDATE outbox SET state = ?, attempts = ?, next_at = ?, last_error = ? WHERE id = ?", [
          attempts >= OUTBOX_MAX_ATTEMPTS ? "dead" : "pending", attempts, now + outboxBackoffMs(attempts), `${only} failed`, row.id,
        ]);
      } else {
        // The integrations that took it are done; each one that failed gets its own row and retries alone.
        await db.tx(async (tx) => {
          for (const id of r.failed)
            await tx.run("INSERT INTO outbox (id, event_seq, target, state, attempts, next_at, last_error, created_at) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)", [
              newId(), row.event_seq, `integration:${id}`, now + outboxBackoffMs(1), `${id} failed`, Date.now(),
            ]);
          await tx.run("UPDATE outbox SET state = 'delivered', delivered_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?", [Date.now(), `retrying: ${r.failed.join(", ")}`, row.id]);
        });
      }
    } catch (e) {
      failed++;
      const attempts = Number(row.attempts) + 1;
      await db
        .run("UPDATE outbox SET state = ?, attempts = ?, next_at = ?, last_error = ? WHERE id = ?", [attempts >= OUTBOX_MAX_ATTEMPTS ? "dead" : "pending", attempts, now + outboxBackoffMs(attempts), errText(e).slice(0, 500), row.id])
        .catch(() => {});
    }
  }
  return { delivered, failed };
}
