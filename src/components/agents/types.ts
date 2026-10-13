// The agent platform's REST JSON as the Automation UI reads it (master plan §3.5). Client-side shapes only: the
// routes own the real ones (src/app/api/agents/*), and every field the UI can live without is optional, so an older or
// newer server never breaks a screen — a missing field shows as "—", never as a crash.
import type { AgentMode, AgentPrincipal, ResourceSelector } from "../../lib/agents/types.ts";
import type { RunState, StepKind, StepState } from "../../lib/agents/records.ts";

export type { AgentMode, RunState, StepKind, StepState };
export type RunKind = "assistant" | "workflow" | "external";

export interface RunConnectionRef {
  id: string;
  label?: string;
  payer?: string;
  provider?: string;
}

// GET /api/agents/runs → { runs: RunListItem[] }
export interface RunListItem {
  id: string;
  kind: RunKind;
  title: string | null;
  state: RunState;
  initiator?: string | { id?: string; email?: string | null } | null; // the person who started it (email)
  connection?: RunConnectionRef | null;
  createdAt: number;
  updatedAt: number;
  waitingFor?: string;
  error?: string | null;
}

export interface RunStep {
  id: string;
  seq: number;
  kind: StepKind;
  name?: string | null;
  state: StepState;
  attempt?: number;
  createdAt?: number;
  updatedAt?: number;
  error?: string | null;
  operationId?: string | null;
  grantId?: string | null;
  summary?: string; // a one-line description of what the step did (tool name and target, the answer's first line, …)
  evidence?: string[]; // citation ids this step produced
  evidenceId?: string; // the runner's form: the one citation id a tool step produced
  source?: string;
  // A workflow run paused for a person (PATCH /api/agents/workflows/[id] { action: "review", runId, decision }).
  review?: { message?: string; additions?: string[]; removals?: string[]; expiresAt?: number };
}

// A piece of evidence a run collected: tool output, redacted and minimised, cited as E1, E2, … in answers and plans.
export interface EvidenceItem {
  id: string; // "E1"
  source: string; // "services.get staging/api", "logs.search …"
  observedAt: number;
  summary?: string;
  stepId?: string;
  op?: string;
  ageSeconds?: number;
  isError?: boolean;
  outcome?: "result" | "denied" | "error"; // denied: the policy refused the call (a prevented violation)
  cut?: string[]; // what minimisation removed
  redacted?: string[]; // which kinds of secret were removed
}

// A change the agent asked for: an approval request bound to an exact plan (grants.ts).
export interface ProposalView {
  grantId: string;
  approvalId: string | null;
  op: string;
  targets: string[];
  planHash: string | null;
  plan: PlanLike | null;
  expiresAt: number | null;
  state: "pending" | "approved" | "rejected" | "expired" | "invalidated" | "consumed" | string;
  env?: string | null;
  why?: string; // the agent's stated reason, citing evidence ids
  // The citation ids the proposal rests on — a list, or the runner's { ids, newestAgeSeconds, stale?, refreshed? }
  // (evidence refreshed before the request when it was older than the policy allows).
  evidence?: string[] | { ids?: string[]; newestAgeSeconds?: number; stale?: boolean; refreshed?: string };
  reason?: string; // why it was invalidated, or the decider's reason
  consumers?: string[]; // who else reads what changes (shared references, dependants)
  bounds?: string[]; // cost and capacity limits the change stays within
  verifies?: string; // how success will be judged
  invalidationReason?: string | null;
}

export interface PlanLike {
  summary: string;
  changes?: string[];
  warnings?: string[];
  estimate?: { monthlyUsd: number; note: string };
  confirm?: string;
}

export interface OperationRef {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "outcome_unknown" | "cancelled" | string;
  verify?: boolean | number | null | { ok?: boolean; detail?: string } | string; // "verified" | "failed"; null = still verifying
  action?: string;
  error?: string | null;
  detail?: string;
  createdAt?: number;
  finishedAt?: number;
}

export type AiOutcome = "completed" | "incomplete" | "failed" | "pending";
export type AwsOutcome = "accepted" | "none" | "unknown";
export type HealthOutcome = "verified" | "unhealthy" | "pending" | "n/a";
export interface RunOutcome {
  ai: AiOutcome;
  aws: AwsOutcome;
  health: HealthOutcome;
  text?: { ai: string; aws: string; health: string }; // the runner's own sentence for each (src/lib/agents/evidence.ts runOutcome)
}

// Limits and what has been used against them. Each run carries its policy's limits; usage grows with the run.
export interface BudgetLike {
  runtimeSeconds?: number;
  turns?: number; // the runner's RunBudget name (src/lib/agents/budget.ts)
  modelTurns?: number; // the policy's name
  toolCalls?: number;
  costUsd?: number;
  maxOutputTokens?: number;
}
export interface UsageLike {
  runtimeSeconds?: number;
  elapsedMs?: number;
  modelTurns?: number;
  turns?: number;
  toolCalls?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  costUnmeasured?: number; // model calls whose cost couldn't be measured (no price is guessed)
  inputTokens?: number;
  outputTokens?: number;
}

// GET /api/agents/runs/[id] → { run: RunDetail } or the detail itself
// The runner's budget view (src/lib/agents/budget.ts BudgetView): limits, what was used, and how cost was measured.
export interface BudgetViewLike {
  limits: BudgetLike;
  used: { turns?: number; toolCalls?: number; seconds?: number; costUsd?: number; inputTokens?: number; outputTokens?: number };
  remaining?: BudgetLike;
  reservedForChildren?: { turns?: number; toolCalls?: number; costUsd?: number };
  cost?: "estimated" | "partly estimated" | "not measurable" | "none";
}

export interface RunDetail extends RunListItem {
  // The full principal, or the runner's summary { kind, runId, delegator, mode, policyHash }.
  principal?: (Partial<AgentPrincipal> & { delegator?: string }) | null;
  scope?: ResourceSelector | null;
  policyHash?: string | null;
  mode?: AgentMode;
  budget?: BudgetLike | BudgetViewLike | null;
  usage?: UsageLike | null;
  steps?: RunStep[];
  evidence?: EvidenceItem[];
  proposals?: ProposalView[];
  operations?: OperationRef[];
  outcome?: RunOutcome;
  answer?: string | { text: string; citations?: string[]; incomplete?: boolean } | null; // the model's final text, citing evidence ids
  resourceKey?: string | null;
  agent?: { id?: string; version?: number; name?: string } | null;
  workflow?: { id?: string; version?: number; name?: string } | null;
  evidenceMaxAgeSeconds?: number; // the policy's evidence age limit
  parentRunId?: string | null;
  cancelRequestedAt?: number | null;
  deadlineAt?: number | null;
  finishedAt?: number | null;
  children?: { id: string; state: RunState }[];
}

// GET /api/agents/metrics (AGENT_ARCHITECTURE §9 release metrics)
export interface RunMetrics {
  since: number;
  runs: number;
  verifiedCompletion: number | null | { count?: number; rate?: number | null }; // the share of accepted changes verified healthy (null: none yet)
  escalations: number | { count?: number; rate?: number | null };
  changes?: number;
  verifiedChanges?: number;
  unmeasuredModelCalls?: number;
  outcomeUnknown: number;
  preventedViolations: number;
  duplicateEffects: number;
  approvalsInvalidated: number;
  estimatedCostUsd: number | null;
}

// GET /api/agents/workflows → { workflows: WorkflowItem[] }
export interface WorkflowItem {
  id: string;
  version: number;
  name: string;
  state: "draft" | "published" | "disabled";
  trigger?: unknown; // the first trigger (§3.5); `triggers` has them all
  triggers?: unknown[];
  scope?: ResourceSelector | null;
  activeVersion?: number; // the published version that runs, when it isn't this one
  mode?: string;
  hash?: string | null;
  publishedAt?: number | null;
  template?: string | null;
  connectionId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

// PATCH /api/agents/workflows/[id] { action: "preview" } → WorkflowPreview
export interface WorkflowPreview {
  trigger: unknown;
  resources: string[];
  steps: unknown[];
  limits: unknown;
  approvals: unknown;
  destination: unknown;
  payer: string;
  warnings?: string[];
  hash?: string;
}

// GET /api/agents/definitions → { definitions: DefinitionItem[] }
export interface DefinitionItem {
  id: string;
  version: number;
  name: string;
  mode: AgentMode;
  tools: string[] | { read?: string[]; propose?: string[]; act?: string[]; deny?: string[] };
  policyHash: string;
  configHash: string;
  createdAt: number;
  archivedAt?: number | null;
  template?: string | null;
  instructions?: string | null;
  builtIn?: boolean; // one of the six templates (version 0), listed alongside
  owner?: string | null;
  policy?: import("../../lib/agents/types.ts").AgentPolicy; // GET /api/agents/definitions/[id] only
}

// GET /api/agents/settings
export interface AgentSettings {
  enabled: { on: boolean; source: "env" | "settings" | "default" };
  stop: StopState;
  worker?: { started: boolean; draining: boolean; inflight: number; handlers: string[] };
  overridden?: boolean;
  note?: string;
}

// GET /api/agents/emergency-stop
export interface StopState {
  on: boolean;
  by?: string;
  at?: number;
  reason?: string;
}

// GET /api/agents/tokens → { tokens: AgentTokenItem[] }
export interface AgentTokenItem {
  id: string;
  name: string | null;
  kind: "run" | "external";
  definitionId: string | null;
  definitionVersion?: number | null;
  prefix: string;
  runId?: string | null;
  owner?: { id: string | null; email: string | null };
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  uses: number;
  status?: "active" | "expired" | "revoked";
}
