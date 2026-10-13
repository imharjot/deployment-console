// Agent tokens (`Authorization: Bearer da_…`, master plan §3.4 / §6 C1). Two kinds, both a delegate of one person:
//
// - run tokens: minted by the runner for one durable run (an embedded `claude` CLI calls the console's MCP server with
//   it). They expire with the run's deadline and are revoked the moment the run ends (store.ts updateRun).
// - external tokens: minted by a person on the Connect screen for an external agent (Claude Desktop, a CI bot). Each
//   binds the policy of an agent definition (a stored one, or a built-in template) and has its own run record of kind
//   `external`, which every call is recorded against. 7, 30 or 90 days.
//
// Only sha256(token) is stored, the plain token is shown once. A token carries no role: every request re-reads the
// delegator, so demoting or disabling the person takes effect within the 5 s lookup cache. A token stops working when
// its run ends, its policy changed (hash mismatch) or agents are turned off (the proxy). Where a token may go is
// tokenRoute() (src/lib/automation.ts); what it may do is the policy engine (src/lib/agents/policy.ts).
import "server-only";
import { hashToken, newToken } from "../../authn.ts";
import {
  AGENT_TOKEN_PREFIX, EXTERNAL_TOKEN_DAYS, MAX_EXTERNAL_TOKENS_PER_USER, agentTokenDisplayPrefix, isAgentTokenShape, parsePrincipal, runTokenExpiry, type AgentTokenKind,
} from "../../agents/identity.ts";
import { isFinalRun } from "../../agents/run-state.ts";
import { DEFAULT_POLICIES, isTemplateName, parsePolicy, policyHash } from "../../agents/policy.ts";
import type { AgentTokenRow, RunState } from "../../agents/records.ts";
import type { AgentPolicy, AgentPrincipal } from "../../agents/types.ts";
import { tokenNameProblem } from "../../automation.ts";
import type { User } from "../../rbac.ts";
import { getDb, newId } from "../db.ts";
import { HttpError } from "../errors.ts";
import { AGENTS_OFF, agentsEnabled } from "../agents/stop.ts";
import { createRun, getRun, updateRun } from "../agents/store.ts";
import { auditOrFail } from "./audit.ts";
import { toUser } from "./users.ts";

// ---------- definitions ----------

export interface ResolvedDefinition {
  id: string;
  version: number; // 0 for a built-in template
  name: string;
  policy: AgentPolicy;
  builtIn: boolean;
}

// A stored agent definition (its newest, unarchived version) or, before any exist, a built-in template by name.
export async function resolveDefinition(id: string): Promise<ResolvedDefinition | undefined> {
  if (typeof id !== "string" || !id || id.length > 100) return undefined;
  const row = await (await getDb()).get<{ id: string; version: number; name: string; policy: string | null }>(
    "SELECT id, version, name, policy FROM agent_definitions WHERE id = ? AND archived_at IS NULL ORDER BY version DESC LIMIT 1",
    [id],
  );
  if (row) {
    try {
      return { id: row.id, version: Number(row.version), name: row.name, policy: parsePolicy(JSON.parse(row.policy ?? "null")), builtIn: false };
    } catch {
      throw new HttpError(409, `agent definition ${id} has an invalid policy — fix it before minting a token`);
    }
  }
  if (isTemplateName(id)) return { id, version: 0, name: id, policy: DEFAULT_POLICIES[id], builtIn: true };
  return undefined;
}

// ---------- mint ----------

// A run token for one run. The principal comes from the run's own record (never from a caller).
export async function mintRunToken(runId: string, principal: AgentPrincipal, ttlMs: number): Promise<string> {
  const run = await getRun(runId);
  if (!run) throw new HttpError(404, "no such run");
  if (isFinalRun(run.state)) throw new HttpError(409, "the run has ended");
  const own = parsePrincipal(run.principal);
  if (principal.runId !== runId || principal.policyHash !== run.policy_hash || !own || own.id !== principal.id || own.delegatorId !== principal.delegatorId)
    throw new HttpError(409, "the principal doesn't belong to this run");
  const now = Date.now();
  const token = AGENT_TOKEN_PREFIX + newToken();
  await (await getDb()).run(
    `INSERT INTO agent_tokens (id, kind, name, owner_id, run_id, principal, policy_hash, hash, prefix, uses, created_at, expires_at)
     VALUES (?, 'run', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [newId(), `run ${runId.slice(0, 8)}`, principal.delegatorId, runId, JSON.stringify(principal), principal.policyHash, hashToken(token), agentTokenDisplayPrefix(token), now, runTokenExpiry(now, ttlMs, run.deadline_at)],
  );
  return token;
}

// People only (the route; master plan §3.4 mintExternalToken(user, defId, days)). The name defaults to the definition's.
// Creates the external run record and the token in one transaction, audited first.
export async function mintExternalToken(
  user: User,
  defId: unknown,
  days: unknown,
  o: { name?: unknown; ip?: string } = {},
): Promise<{ token: string; id: string; runId: string; expiresAt: number }> {
  if (!(EXTERNAL_TOKEN_DAYS as readonly unknown[]).includes(days)) throw new HttpError(400, `days must be ${EXTERNAL_TOKEN_DAYS.join(", ")}`);
  if (typeof defId !== "string") throw new HttpError(400, "definitionId must be an agent definition id or a template name");
  // A token that couldn't be used isn't handed out: while agents are off the proxy would refuse it anyway.
  if (!(await agentsEnabled()).on) throw Object.assign(new HttpError(503, AGENTS_OFF), { code: "agents_off" });
  const def = await resolveDefinition(defId);
  if (!def) throw new HttpError(404, `no agent definition "${defId}"`);
  const rawName = o.name ?? def.name;
  const problem = tokenNameProblem(rawName);
  if (problem) throw new HttpError(400, problem);
  const name = String(rawName).trim();
  const ip = o.ip;
  const now = Date.now();
  const expiresAt = now + (days as number) * 86_400_000;
  const id = newId();
  const runId = newId();
  const hash = policyHash(def.policy);
  const principal: AgentPrincipal = {
    id: `agent:${runId}`, kind: "agent", runId, tokenId: id, delegatorId: user.id, delegatorEmail: user.email, agentId: def.id, agentVersion: def.version,
    policyHash: hash, mode: def.policy.mode,
  };
  const token = AGENT_TOKEN_PREFIX + newToken();
  const db = await getDb();
  await db.tx(async (tx) => {
    const live = await tx.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM agent_tokens WHERE owner_id = ? AND kind = 'external' AND revoked_at IS NULL AND expires_at > ?", [user.id, now]);
    if (Number(live?.n ?? 0) >= MAX_EXTERNAL_TOKENS_PER_USER) throw new HttpError(409, `you already have ${MAX_EXTERNAL_TOKENS_PER_USER} active agent tokens — revoke one first`);
    await auditOrFail({ action: "agent_token.create", actor: user.email, target: name, ip, params: { id, runId, definition: def.id, version: def.version, mode: def.policy.mode, expiresAt } });
    await createRun(
      { id: runId, kind: "external", title: `External agent "${name}"`, initiatorId: user.id, principal, agentId: def.id, agentVersion: def.version, policy: def.policy, policyHash: hash, state: "running", deadlineAt: expiresAt },
      tx,
    );
    await tx.run(
      `INSERT INTO agent_tokens (id, kind, name, owner_id, definition_id, definition_version, run_id, principal, policy_hash, hash, prefix, scope, uses, created_at, expires_at)
       VALUES (?, 'external', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, name, user.id, def.id, def.version, runId, JSON.stringify(principal), hash, hashToken(token), agentTokenDisplayPrefix(token), JSON.stringify(def.policy.scope), now, expiresAt],
    );
  });
  return { token, id, runId, expiresAt };
}

// ---------- list / revoke ----------

export interface AgentTokenItem {
  id: string;
  name: string;
  kind: AgentTokenKind;
  definitionId: string | null;
  definitionVersion: number | null;
  prefix: string;
  runId: string | null;
  owner: { id: string | null; email: string | null };
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  uses: number;
  status: "active" | "expired" | "revoked";
}

type ItemRow = AgentTokenRow & { email: string | null };
const toItem = (r: ItemRow, now = Date.now()): AgentTokenItem => ({
  id: r.id, name: r.name ?? "", kind: r.kind, definitionId: r.definition_id, definitionVersion: r.definition_version === null ? null : Number(r.definition_version),
  prefix: r.prefix, runId: r.run_id, owner: { id: r.owner_id, email: r.email ?? null }, createdAt: Number(r.created_at),
  expiresAt: r.expires_at === null ? null : Number(r.expires_at), lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at), uses: Number(r.uses ?? 0),
  status: r.revoked_at ? "revoked" : r.expires_at && Number(r.expires_at) <= now ? "expired" : "active",
});
const SELECT = "SELECT t.*, u.email FROM agent_tokens t LEFT JOIN users u ON u.id = t.owner_id";

// External tokens: mine, or everyone's for an admin (`all`). Run tokens are internal and never listed.
export async function listAgentTokens(user: User, all: boolean): Promise<AgentTokenItem[]> {
  const db = await getDb();
  const rows = all
    ? await db.all<ItemRow>(`${SELECT} WHERE t.kind = 'external' ORDER BY t.created_at DESC LIMIT 500`)
    : await db.all<ItemRow>(`${SELECT} WHERE t.kind = 'external' AND t.owner_id = ? ORDER BY t.created_at DESC LIMIT 200`, [user.id]);
  const now = Date.now();
  const order = { active: 0, expired: 1, revoked: 2 };
  return rows.map((r) => toItem(r, now)).sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
}

export async function agentTokenById(id: string): Promise<AgentTokenItem | undefined> {
  const r = await (await getDb()).get<ItemRow>(`${SELECT} WHERE t.id = ?`, [id]);
  return r ? toItem(r) : undefined;
}

// Own token, or anyone's for an admin. Revoking is "stop this agent": the external run is cancelled and its pending
// approval requests are rejected in the same transaction.
export async function revokeAgentToken(actor: User, id: string, ip?: string): Promise<AgentTokenItem> {
  const t = await agentTokenById(id);
  if (!t || t.kind !== "external" || (t.owner.id !== actor.id && actor.role !== "admin")) throw new HttpError(404, "no such agent token");
  if (t.revokedAt) return t;
  const now = Date.now();
  const db = await getDb();
  await db.tx(async (tx) => {
    await auditOrFail({ action: "agent_token.revoke", actor: actor.email, target: t.name, ip, params: { id, owner: t.owner.email, runId: t.runId } });
    await tx.run("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]);
    if (t.runId) {
      await tx.run("UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, detail = ? WHERE run_id = ? AND status = 'pending'", [now, actor.email, "agent token revoked", t.runId]);
      await tx.run("UPDATE approval_grants SET invalidated_at = ?, invalidation_reason = ? WHERE run_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL", [now, "agent token revoked", t.runId]);
    }
  });
  if (t.runId) {
    const run = await getRun(t.runId);
    if (run && !isFinalRun(run.state)) await updateRun(t.runId, { state: "cancelled", error: "the agent token was revoked" }).catch(() => {});
  }
  forgetAgentTokens();
  return (await agentTokenById(id))!;
}

// When a run ends (updateRun revokes them in its transaction too; this is for callers outside one).
export async function revokeRunTokens(runId: string): Promise<number> {
  const n = await (await getDb()).run("UPDATE agent_tokens SET revoked_at = ? WHERE run_id = ? AND kind = 'run' AND revoked_at IS NULL", [Date.now(), runId]);
  forgetAgentTokens();
  return n;
}

// ---------- verify (the proxy, on every request that carries `Bearer da_…`) ----------

export interface AgentTokenIdentity {
  user: User; // the delegator, with their current role
  principal: AgentPrincipal;
  policy: AgentPolicy;
  token: { id: string; name: string; kind: AgentTokenKind; runId: string };
}

interface Live {
  id: string;
  name: string;
  kind: AgentTokenKind;
  runId: string | null;
  principal: AgentPrincipal | undefined;
  tokenPolicyHash: string | null;
  expiresAt: number | null;
  owner: User | undefined;
  ownerDisabled: boolean;
  runState: RunState | null;
  runPolicy: string | null;
  runPolicyHash: string | null;
  cachedAt: number;
}

const CACHE_MS = 5_000;
const g = globalThis as typeof globalThis & { __consoleAgentTokens?: Map<string, Live | null> };
const cache = (g.__consoleAgentTokens ??= new Map<string, Live | null>());
export const forgetAgentTokens = () => cache.clear();

export type AgentTokenCheck = { ok: true; id: AgentTokenIdentity } | { ok: false; error: string };

async function load(hash: string, now: number): Promise<Live | null> {
  const r = await (await getDb()).get<
    AgentTokenRow & { u_id: string | null; u_email: string | null; u_name: string | null; u_role: string | null; u_disabled: number | null; r_state: RunState | null; r_policy: string | null; r_policy_hash: string | null }
  >(
    `SELECT t.*, u.id AS u_id, u.email AS u_email, u.name AS u_name, u.role AS u_role, u.disabled AS u_disabled, r.state AS r_state, r.policy AS r_policy, r.policy_hash AS r_policy_hash
       FROM agent_tokens t LEFT JOIN users u ON u.id = t.owner_id LEFT JOIN agent_runs r ON r.id = t.run_id
      WHERE t.hash = ? AND t.revoked_at IS NULL`,
    [hash],
  );
  if (!r) return null;
  return {
    id: r.id, name: r.name ?? "", kind: r.kind, runId: r.run_id, principal: parsePrincipal(r.principal), tokenPolicyHash: r.policy_hash,
    expiresAt: r.expires_at === null ? null : Number(r.expires_at), owner: r.u_id ? toUser({ id: r.u_id, email: r.u_email ?? "", name: r.u_name, role: r.u_role ?? "viewer" }) : undefined,
    ownerDisabled: !r.u_id || !!Number(r.u_disabled), runState: r.r_state, runPolicy: r.r_policy, runPolicyHash: r.r_policy_hash, cachedAt: now,
  };
}

export async function verifyAgentToken(token: string): Promise<AgentTokenCheck> {
  if (!isAgentTokenShape(token)) return { ok: false, error: "malformed agent token" };
  const hash = hashToken(token);
  const now = Date.now();
  let live = cache.get(hash);
  if (live === undefined || (live && now - live.cachedAt > CACHE_MS) || (live === null && cache.size > 5_000)) {
    live = await load(hash, now);
    cache.set(hash, live);
    if (cache.size > 5_000) for (const [k, v] of cache) if (!v || now - v.cachedAt > CACHE_MS) cache.delete(k);
  }
  if (!live) return { ok: false, error: "invalid or revoked agent token" };
  if (live.expiresAt && live.expiresAt <= now) return { ok: false, error: "this agent token has expired — create a new one under Automation → Connect your agent" };
  if (live.ownerDisabled || !live.owner) return { ok: false, error: "the person this agent acts for is disabled or no longer exists" };
  if (!live.runId || !live.runState) return { ok: false, error: "this agent token's run no longer exists" };
  if (isFinalRun(live.runState)) return { ok: false, error: `this agent's run has ended (${live.runState.replace(/_/g, " ")})` };
  const p = live.principal;
  if (!p || p.runId !== live.runId || p.delegatorId !== live.owner.id) return { ok: false, error: "this agent token's identity is unreadable" };
  // The run's stored policy is the one in force; a token minted for another version of it is refused.
  if (!live.runPolicyHash || p.policyHash !== live.runPolicyHash || live.tokenPolicyHash !== live.runPolicyHash)
    return { ok: false, error: "the agent's policy changed since this token was created — create a new token" };
  let policy: AgentPolicy;
  try {
    policy = parsePolicy(JSON.parse(live.runPolicy ?? "null"));
    if (policyHash(policy) !== live.runPolicyHash) throw new Error("hash");
  } catch {
    return { ok: false, error: "the agent's stored policy is invalid — create a new token" };
  }
  return { ok: true, id: { user: live.owner, principal: { ...p, tokenId: p.tokenId ?? live.id }, policy, token: { id: live.id, name: live.name, kind: live.kind, runId: live.runId } } };
}

// For long-lived connections (the event stream): still usable? Re-checked every heartbeat.
export async function agentTokenStillValid(id: string): Promise<boolean> {
  const r = await (await getDb()).get<{ revoked_at: number | null; expires_at: number | null; disabled: number | null; u_id: string | null; state: RunState | null }>(
    `SELECT t.revoked_at, t.expires_at, u.disabled, u.id AS u_id, r.state FROM agent_tokens t LEFT JOIN users u ON u.id = t.owner_id
       LEFT JOIN agent_runs r ON r.id = t.run_id WHERE t.id = ?`,
    [id],
  );
  return !!r && !r.revoked_at && !(r.expires_at && Number(r.expires_at) <= Date.now()) && !!r.u_id && !Number(r.disabled) && !!r.state && !isFinalRun(r.state);
}

// Usage counts, flushed at most every 30 s per token (like API tokens).
const use = ((g as { __consoleAgentTokenUse?: Map<string, { n: number; flushedAt: number; timer?: ReturnType<typeof setTimeout> }> }).__consoleAgentTokenUse ??= new Map());
function flush(id: string) {
  const u = use.get(id);
  if (!u) return;
  if (u.timer) clearTimeout(u.timer);
  u.timer = undefined;
  const add = u.n, now = Date.now();
  u.n = 0;
  u.flushedAt = now;
  void getDb()
    .then((db) => db.run("UPDATE agent_tokens SET last_used_at = ?, uses = uses + ? WHERE id = ?", [now, add, id]))
    .catch(() => {
      u.n += add;
    });
}
export function noteAgentTokenUse(id: string, n = 1) {
  const u = use.get(id) ?? { n: 0, flushedAt: 0 };
  u.n += n;
  use.set(id, u);
  const wait = 30_000 - (Date.now() - u.flushedAt);
  if (wait <= 0) return flush(id);
  if (!u.timer) {
    u.timer = setTimeout(() => flush(id), wait);
    u.timer.unref?.();
  }
}
