// Agent identity rules, pure (master plan §6 C1): the `da_` token shape, how a principal is read back from storage,
// what the audit log calls an agent, how long a run token lives and what /api/me may say about a principal. The
// server side is src/lib/server/auth/agent-tokens.ts (tokens) and src/lib/server/agents/principals.ts (principals).
import { AGENT_MODES, type AgentMode, type AgentPrincipal } from "./types.ts";

// "da_" + 32 random bytes (base64url) — like API tokens' "dc_", so secret scanners recognise both.
export const AGENT_TOKEN_PREFIX = "da_";
export const isAgentTokenShape = (t: unknown): t is string => typeof t === "string" && /^da_[A-Za-z0-9_-]{43}$/.test(t);
export const agentTokenDisplayPrefix = (t: string) => t.slice(0, 10);

export type AgentTokenKind = "run" | "external";
export const EXTERNAL_TOKEN_DAYS = [7, 30, 90] as const;
export const MAX_EXTERNAL_TOKENS_PER_USER = 25;

// A run token never outlives its run: at most the run's deadline (and at most a day, whatever the deadline says).
export const RUN_TOKEN_MAX_MS = 24 * 3_600_000;
export function runTokenExpiry(now: number, ttlMs: number, deadlineAt: number | null | undefined): number {
  const ttl = Math.min(Math.max(ttlMs, 1_000), RUN_TOKEN_MAX_MS);
  const end = now + ttl;
  return deadlineAt && deadlineAt > now ? Math.min(end, deadlineAt) : end;
}

const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v: unknown, max = 200) => v === undefined || v === null || str(v, max);
const optInt = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

// A principal as stored (agent_runs.principal, agent_tokens.principal). Anything malformed → undefined: the caller
// refuses (fails closed) rather than guessing an identity.
export function parsePrincipal(raw: unknown): AgentPrincipal | undefined {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const get = (k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
  if (get("kind") !== "agent" || !str(get("id")) || !str(get("delegatorId")) || !str(get("delegatorEmail"), 254) || !str(get("policyHash"))) return undefined;
  if (!AGENT_MODES.includes(get("mode") as AgentMode)) return undefined;
  for (const k of ["runId", "tokenId", "agentId", "workflowId", "parentRunId"]) if (!optStr(get(k))) return undefined;
  for (const k of ["agentVersion", "workflowVersion"]) if (!optInt(get(k))) return undefined;
  const p: AgentPrincipal = {
    id: get("id") as string,
    kind: "agent",
    delegatorId: get("delegatorId") as string,
    delegatorEmail: get("delegatorEmail") as string,
    policyHash: get("policyHash") as string,
    mode: get("mode") as AgentMode,
  };
  for (const k of ["runId", "tokenId", "agentId", "workflowId", "parentRunId"] as const) if (typeof get(k) === "string") p[k] = get(k) as string;
  for (const k of ["agentVersion", "workflowVersion"] as const) if (typeof get(k) === "number") p[k] = get(k) as number;
  return p;
}

// What the audit log and operation records show as the actor: the agent and the person it acts for, never a role.
export const agentActor = (p: Pick<AgentPrincipal, "runId" | "delegatorEmail" | "tokenId">, tokenName?: string) =>
  `agent ${p.runId ? `run ${p.runId.slice(0, 8)}` : "(no run)"}${tokenName ? ` via agent token "${tokenName}"` : ""} for ${p.delegatorEmail}`;

// GET /api/me for an agent token (§3.5): enough for a client to know what it is, nothing it could use.
export const principalSummary = (p: AgentPrincipal) => ({ kind: "agent" as const, runId: p.runId, delegator: p.delegatorEmail, mode: p.mode, policyHash: p.policyHash });

// The fields of an operation's input only a person supplies: the typed confirmation, the acknowledgement that
// database migrations changed, and the reason an approver adds. An agent's own values for them are never part of what
// a grant binds (the approver's replace them when the change runs), and an agent may not acknowledge migrations.
export const HUMAN_FIELDS = ["confirm", "migrationAck", "reason"] as const;
export const AGENT_FORBIDDEN_FIELDS = ["migrationAck"] as const;

export function withoutHumanFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (!(HUMAN_FIELDS as readonly string[]).includes(k)) out[k] = v;
  return out;
}
