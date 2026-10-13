// Agent principals (master plan §3.4 / §6 C1, AGENT_ARCHITECTURE §3 "the integration mistake"). An agent acts as a
// server-built delegate of one person — never with that person's session, never with an identity a model supplied.
//
// - principalForRun(run) / principalForToken(id): the principal as stored with the run or token (malformed → refused).
// - delegatorOf(p): the delegator *now* — re-read on every call, so demoting or disabling the person takes effect at
//   once; the agent's effective role is that current role (and the policy narrows it further).
// - agentCaller(p): what the in-process runner passes to invoke() — `via: "agent"`, the principal and its run's policy.
// - withAgentContext(p, fn) / currentAgentContext(): an AsyncLocalStorage on globalThis.__consoleAgentAls. The runner
//   wraps every model-driven call in it, and invoke() refuses any caller that isn't the agent while it is set: an
//   embedded agent can't borrow the chatting person's session to skip its approval rules. outsideAgentContext(fn)
//   starts long-lived work (the worker's timer) with no agent context at all.
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { parsePrincipal } from "../../agents/identity.ts";
import { parsePolicy, policyHash } from "../../agents/policy.ts";
import { isFinalRun } from "../../agents/run-state.ts";
import type { AgentRunRow, AgentTokenRow } from "../../agents/records.ts";
import type { AgentPolicy, AgentPrincipal } from "../../agents/types.ts";
import type { User } from "../../rbac.ts";
import { userById, toUser } from "../auth/users.ts";
import { getDb } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { Caller } from "../ops/index.ts";
import { getRun } from "./store.ts";

// The context lasts as long as the wrapped call, not as long as what it left behind: AsyncLocalStorage hands its store
// to every timer and promise created inside, so a loop re-armed from inside an agent's call (the worker's, a cache
// refresh) would otherwise carry that agent's identity forever — and refuse every later caller that isn't that agent.
// Once fn settles its scope is closed, and anything still running from it sees no agent context.
interface AgentScope {
  principal: AgentPrincipal;
  open: boolean;
}
const g = globalThis as { __consoleAgentAls?: AsyncLocalStorage<AgentScope | AgentPrincipal> };
const als = (g.__consoleAgentAls ??= new AsyncLocalStorage<AgentScope | AgentPrincipal>());

export function withAgentContext<T>(p: AgentPrincipal, fn: () => Promise<T>): Promise<T> {
  const scope: AgentScope = { principal: p, open: true };
  return als.run(scope, async () => {
    try {
      return await fn();
    } finally {
      scope.open = false;
    }
  });
}

export function currentAgentContext(): AgentPrincipal | undefined {
  const s = als.getStore();
  if (!s) return undefined;
  if ("kind" in s) return s; // a store set by an older copy of this module (hot reload): a bare principal
  return s.open ? s.principal : undefined;
}

// Starts long-lived work (a loop's timer, a background refresh) outside any agent's context, whoever triggered it.
export function outsideAgentContext<T>(fn: () => T): T {
  return als.exit(fn);
}

const refused = (status: number, message: string, code: string) => Object.assign(new HttpError(status, message), { code });

export function principalForRun(run: Pick<AgentRunRow, "id" | "principal" | "policy_hash">): AgentPrincipal {
  const p = parsePrincipal(run.principal);
  if (!p || p.runId !== run.id) throw refused(409, "this run's agent identity is unreadable", "principal_invalid");
  if (p.policyHash !== run.policy_hash) throw refused(409, "the run's policy changed since it started", "policy_changed");
  return p;
}

export async function principalForToken(t: string | Pick<AgentTokenRow, "id" | "principal" | "run_id" | "revoked_at" | "expires_at">): Promise<AgentPrincipal> {
  const row = typeof t === "string" ? await (await getDb()).get<AgentTokenRow>("SELECT * FROM agent_tokens WHERE id = ?", [t]) : t;
  if (!row || row.revoked_at || (row.expires_at && Number(row.expires_at) <= Date.now())) throw refused(401, "invalid, revoked or expired agent token", "token_invalid");
  const p = parsePrincipal(row.principal);
  if (!p || p.runId !== row.run_id) throw refused(401, "this agent token's identity is unreadable", "principal_invalid");
  return { ...p, tokenId: p.tokenId ?? row.id };
}

// The person the agent acts for, as they are now. Disabled or deleted → 401: their agents stop with them.
export async function delegatorOf(p: Pick<AgentPrincipal, "delegatorId">): Promise<User> {
  const row = await userById(p.delegatorId);
  if (!row || Number(row.disabled)) throw refused(401, "the person this agent acts for is disabled or no longer exists", "delegator_gone");
  return toUser(row);
}

// The run's policy, checked against the principal's hash (a policy edited under a running agent is refused) — and the
// principal against the run's own: a principal can't borrow another person's run.
export async function policyForRun(runId: string, p: AgentPrincipal): Promise<{ run: AgentRunRow; policy: AgentPolicy }> {
  const run = await getRun(runId);
  if (!run) throw refused(404, "no such run", "run_missing");
  if (isFinalRun(run.state)) throw refused(409, `this agent's run has ended (${run.state.replace(/_/g, " ")})`, "run_finished");
  const own = parsePrincipal(run.principal);
  if (!own || own.runId !== runId || own.delegatorId !== p.delegatorId || p.runId !== runId) throw refused(409, "this agent identity doesn't belong to that run", "principal_mismatch");
  let policy: AgentPolicy;
  try {
    policy = parsePolicy(JSON.parse(run.policy ?? "null"));
  } catch {
    throw refused(409, "the run's stored policy is invalid", "policy_invalid");
  }
  if (policyHash(policy) !== run.policy_hash || p.policyHash !== run.policy_hash) throw refused(409, "the run's policy changed since it started", "policy_changed");
  return { run, policy };
}

// For the in-process runner (c-runner) and the worker's execute steps: a Caller for invoke() as this run's agent.
export async function agentCaller(p: AgentPrincipal, o: { stepId?: string; grantId?: string } = {}): Promise<Caller> {
  if (!p.runId) throw refused(400, "an agent caller needs a run", "run_missing");
  const [user, { policy }] = await Promise.all([delegatorOf(p), policyForRun(p.runId, p)]);
  return { user, via: "agent", principal: p, policy, runId: p.runId, tokenId: p.tokenId, stepId: o.stepId, grantId: o.grantId };
}
