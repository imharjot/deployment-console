// The agent platform's identity and policy contracts (master plan §3.4). Pure types, shared by the policy engine
// (./policy.ts), the operations registry, the runner, the workflows and the Automation UI. The model never supplies any
// of these: principals are built by the server from a run or an agent token (src/lib/server/agents/principals.ts), and
// a policy comes from the run's stored record, checked against the principal's hash on every call.

// observe:     scoped reads and explanations; every change is refused.
// propose:     reads, plus concrete plans; every change becomes an approval request a person decides.
// bounded-act: listed changes on explicitly listed, unprotected resources within limits run without a person;
//              everything else becomes an approval request (or is refused).
export type AgentMode = "observe" | "propose" | "bounded-act";
export const AGENT_MODES: readonly AgentMode[] = ["observe", "propose", "bounded-act"];

// Which resources an agent may touch. Every field narrows (AND); an absent or empty list means "no restriction on this
// field". `keys` are canonical coordinator keys ("ecs-service:us-east-1/acme-staging/api") or the inventory's own keys
// ("ecs:service/acme-staging/api", an ARN); bounded-act needs every target listed here explicitly.
export interface ResourceSelector {
  account?: string;
  regions?: string[];
  envs?: string[];
  keys?: string[];
  kinds?: string[];
  tags?: Record<string, string>;
  excludeProtected?: boolean;
}

export interface AgentPolicy {
  version: number;
  mode: AgentMode;
  scope: ResourceSelector;
  // Operation names ("services.restart"), "<area>.*" or "*". deny beats every other list.
  tools: { read: string[]; propose: string[]; act: string[]; deny: string[] };
  limits: {
    runtimeSeconds: number;
    modelTurns: number;
    toolCalls: number;
    concurrentMutations: number;
    mutationsPerResourcePerHour: number;
    maxOutputTokens?: number;
    costUsd?: number;
  };
  evidence: { maximumAgeSeconds: number; requireCompleteSecurityMetadata: boolean };
  approval: { bindPlanHash: true; expireAfterSeconds: number; invalidateOnResourceChange: boolean };
  data: { logs: "redacted-and-bounded" | "none"; secretValues: "forbidden" };
  billing: { connection: string; fallback: "none" };
}

// A server-issued delegate of one person (the delegator). It never carries a role: the delegator's *current* role is
// re-read on every call, so demoting or disabling the person takes effect at once.
export interface AgentPrincipal {
  id: string;
  kind: "agent";
  runId?: string;
  tokenId?: string;
  delegatorId: string;
  delegatorEmail: string;
  agentId?: string;
  agentVersion?: number;
  workflowId?: string;
  workflowVersion?: number;
  policyHash: string;
  mode: AgentMode;
  parentRunId?: string;
}

export type PolicyDecision = { effect: "allow" } | { effect: "approve"; reason: string } | { effect: "deny"; reason: string };
