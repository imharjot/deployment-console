// Approval requests: an agent's change that waits for a person. Storage, state transitions and a tiny pub/sub for the
// live event stream. The input is sealed with secrets.ts (it may hold variable values); the plan is stored in the clear
// and must hold names and counts only (see Plan in ./types.ts). Every transition is a single conditional UPDATE, so two
// approvers racing — or one approving twice — can't both win. Deciding (and running the operation) lives in ./index.ts.
import "server-only";
import { APPROVAL_TTL_MS, effectiveStatus, type ApprovalStatus } from "../../automation.ts";
import { publishSafe } from "../agents/events.ts";
import { getDb, newId } from "../db.ts";
import { seal, unseal } from "../secrets.ts";
import type { Plan } from "./types.ts";

export interface ApprovalRow {
  id: string;
  op: string;
  input: string; // sealed JSON
  plan: string | null;
  env: string | null;
  token_id: string | null;
  requested_by: string; // the token owner's user id (an agent's request: the person it acts for)
  run_id?: string | null; // an agent's request: its run …
  grant_id?: string | null; // … and the exact-plan grant a person decides (src/lib/server/agents/grants.ts)
  plan_hash?: string | null; // the plan as requested; approving re-plans and refuses on any difference
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  result: string | null;
  detail: string | null;
  token_name?: string | null;
  owner_email?: string | null;
}

const SELECT = `SELECT a.*, t.name AS token_name, u.email AS owner_email FROM approvals a
  LEFT JOIN api_tokens t ON t.id = a.token_id LEFT JOIN users u ON u.id = a.requested_by`;

export const MAX_PENDING_PER_TOKEN = 20;

export const openInput = (r: ApprovalRow): Record<string, unknown> => JSON.parse(unseal(r.input)) as Record<string, unknown>;
export const planOf = (r: ApprovalRow): Plan | null => {
  try {
    return r.plan ? (JSON.parse(r.plan) as Plan) : null;
  } catch {
    return null;
  }
};
// "approved" lasts only while the operation runs (seconds). Still approved long after the decision means the process
// died mid-run: report it as failed so nobody waits forever (the audit log shows whether the action went out).
const INTERRUPTED_MS = 10 * 60_000;
// An agent's approved request isn't running yet: it waits for its run's execute step (its grant's expiry decides).
export const interrupted = (r: ApprovalRow) => r.status === "approved" && !r.grant_id && !!r.decided_at && Date.now() - Number(r.decided_at) > INTERRUPTED_MS;
export const statusOf = (r: ApprovalRow): ApprovalStatus => (interrupted(r) ? "failed" : effectiveStatus(r.status, Number(r.created_at)));

// Pending requests past their 24 h are marked expired whenever approvals are read.
async function expireStale() {
  await (await getDb()).run("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND created_at <= ?", [Date.now() - APPROVAL_TTL_MS]);
}

export async function createApproval(a: { op: string; input: Record<string, unknown>; plan: Plan; env?: string; tokenId: string; requestedBy: string; planHash?: string }): Promise<ApprovalRow> {
  const id = newId();
  await (await getDb()).run(
    "INSERT INTO approvals (id, op, input, plan, env, token_id, requested_by, status, created_at, plan_hash) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    [id, a.op, seal(JSON.stringify(a.input)), JSON.stringify(a.plan), a.env ?? null, a.tokenId, a.requestedBy, Date.now(), a.planHash ?? null],
  );
  return (await getApproval(id))!;
}

export async function getApproval(id: string): Promise<ApprovalRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  await expireStale();
  return (await getDb()).get<ApprovalRow>(`${SELECT} WHERE a.id = ?`, [id]);
}

// An agent's request is only still pending while its grant is (not expired, invalidated or rejected) and its run
// hasn't ended — the same rule the approval view applies (ops/index.ts view()), so lists and badges agree with it.
const STILL_PENDING = `(a.grant_id IS NULL OR (
  EXISTS (SELECT 1 FROM approval_grants g WHERE g.id = a.grant_id AND g.invalidated_at IS NULL AND g.consumed_at IS NULL
    AND (g.decision IS NULL OR g.decision <> 'rejected') AND (g.expires_at IS NULL OR g.expires_at > ?))
  AND (a.run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = a.run_id AND r.state NOT IN ('succeeded', 'failed', 'cancelled', 'outcome_unknown')))))`;

export async function listApprovals(f: { status?: ApprovalStatus | "all"; tokenId?: string; runId?: string; limit?: number }): Promise<ApprovalRow[]> {
  await expireStale();
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status && f.status !== "all") {
    where.push("a.status = ?");
    args.push(f.status);
  }
  if (f.status === "pending") {
    where.push(STILL_PENDING);
    args.push(Date.now());
  }
  if (f.tokenId) {
    where.push("a.token_id = ?");
    args.push(f.tokenId);
  }
  if (f.runId) {
    where.push("a.run_id = ?");
    args.push(f.runId);
  }
  args.push(Math.min(Math.max(f.limit ?? 50, 1), 200));
  return (await getDb()).all<ApprovalRow>(`${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY a.created_at DESC LIMIT ?`, args);
}

export async function countPending(tokenId?: string, runId?: string): Promise<number> {
  await expireStale();
  const where = ["a.status = 'pending'", STILL_PENDING];
  const args: unknown[] = [Date.now()];
  if (tokenId) {
    where.push("a.token_id = ?");
    args.push(tokenId);
  } else if (runId) {
    where.push("a.run_id = ?");
    args.push(runId);
  }
  const r = await (await getDb()).get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM approvals a WHERE ${where.join(" AND ")}`, args);
  return Number(r?.n ?? 0);
}

// An agent retrying the same request gets the pending one back instead of a second approval to click through.
export async function findPendingDuplicate(tokenId: string, op: string, input: Record<string, unknown>): Promise<ApprovalRow | undefined> {
  const want = canonical(input);
  const rows = (await listApprovals({ status: "pending", tokenId, limit: MAX_PENDING_PER_TOKEN })).filter((r) => r.op === op);
  return rows.find((r) => {
    try {
      return canonical(openInput(r)) === want;
    } catch {
      return false;
    }
  });
}

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

// pending → approved, atomically, and only while unexpired. False = someone else decided first (or it expired).
export async function claimApproval(id: string, by: string): Promise<boolean> {
  const now = Date.now();
  const n = await (await getDb()).run("UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending' AND created_at > ?", [
    now, by.slice(0, 254), id, now - APPROVAL_TTL_MS,
  ]);
  return n === 1;
}

export async function rejectApproval(id: string, by: string, reason: string | undefined): Promise<boolean> {
  const now = Date.now();
  const n = await (await getDb()).run("UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, detail = ? WHERE id = ? AND status = 'pending' AND created_at > ?", [
    now, by.slice(0, 254), reason?.slice(0, 500) ?? null, id, now - APPROVAL_TTL_MS,
  ]);
  return n === 1;
}

// approved → done | failed, with the operation's (compact) result or the error.
export async function finishApproval(id: string, status: "done" | "failed", result: unknown, detail?: string) {
  let text: string | null = null;
  if (result !== undefined) {
    text = JSON.stringify(result) ?? null;
    if (text && text.length > 20_000) text = JSON.stringify({ truncated: true, preview: text.slice(0, 20_000) });
  }
  await (await getDb()).run("UPDATE approvals SET status = ?, result = ?, detail = ? WHERE id = ? AND status = 'approved'", [status, text, detail?.slice(0, 500) ?? null, id]);
}

export const resultOf = (r: ApprovalRow): unknown => {
  try {
    return r.result ? JSON.parse(r.result) : undefined;
  } catch {
    return undefined;
  }
};

// ---------- live updates (the /api/events stream) ----------

export interface ApprovalEvent {
  event: "created" | "decided" | "done";
  id: string;
  op: string;
  status: ApprovalStatus;
  env: string | null;
  tokenId: string | null;
  runId?: string | null;
  at: number;
}

// On globalThis: routes are separate bundles, and the stream must hear approvals decided in another route.
const g = globalThis as { __consoleApprovalSubs?: Set<(e: ApprovalEvent) => void> };
const subs = (g.__consoleApprovalSubs ??= new Set());

export function onApproval(f: (e: ApprovalEvent) => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

// In-process listeners, and the persisted event stream (src/lib/server/agents/events.ts): people see every approval
// event, an API token its own requests', an agent token its own run's.
export function publishApproval(r: ApprovalRow, event: ApprovalEvent["event"], status?: ApprovalStatus) {
  const e: ApprovalEvent = { event, id: r.id, op: r.op, status: status ?? statusOf(r), env: r.env, tokenId: r.token_id, runId: r.run_id ?? null, at: Date.now() };
  publishSafe("approval", e, { runId: r.run_id ?? null, audience: { people: true, tokens: r.token_id ? [r.token_id] : [] } });
  for (const f of [...subs]) {
    try {
      f(e);
    } catch {
      /* a closed stream must never break the caller */
    }
  }
}
