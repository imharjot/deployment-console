// Row shapes of the agent tables (migration 7 in src/lib/db-core.ts) and the run / step state machines. Rows are what
// the DB returns: snake_case columns, JSON columns as strings, BIGINT timestamps (ms) as numbers, booleans as 0/1.
// Sealed columns (credential, transcript) hold secrets.ts envelopes and are opened only by the credential broker.

export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_external"
  | "paused_auth"
  | "paused_budget"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export type StepState = "queued" | "leased" | "waiting" | "succeeded" | "failed" | "cancelled" | "outcome_unknown" | "skipped";

export type StepKind = "model" | "tool" | "propose" | "approval" | "execute" | "verify" | "wait" | "condition" | "notify";

export const TERMINAL_RUN_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled", "outcome_unknown"];
export const TERMINAL_STEP_STATES: readonly StepState[] = ["succeeded", "failed", "cancelled", "outcome_unknown", "skipped"];

type Json = string; // a JSON document stored as TEXT
type Ms = number; // epoch milliseconds (BIGINT)
type Flag = number; // 0 | 1

export interface AgentConnectionRow {
  id: string;
  owner_id: string | null;
  scope: "personal" | "org";
  provider: string; // "anthropic", "openai", "openai-compatible", "ollama", "bedrock", "scripted", "runtime:claude-code", "chatgpt-plan", …
  auth_kind: string; // "api-key", "oauth", "aws-role", "local-runtime", "none"
  label: string;
  endpoint: string | null;
  model: string | null;
  region: string | null;
  credential: string | null; // sealed
  key_version: number | null;
  egress: "local" | "cloud";
  background_ok: Flag;
  eligibility: Json | null;
  binding: Json | null; // { subject?, clientRegistrationId?, installationHostId? } — never an email
  status: string; // "active" | "needs_auth" | "revoked" | "error"
  created_at: Ms;
  updated_at: Ms;
  last_used_at: Ms | null;
  revoked_at: Ms | null;
  revoke_confirmed: Flag;
}

export interface AgentDefinitionRow {
  id: string;
  version: number;
  owner_id: string | null;
  name: string;
  config_hash: string;
  instructions: string | null;
  tools: Json | null;
  policy: Json | null; // AgentPolicy
  model_req: Json | null;
  created_at: Ms;
  archived_at: Ms | null;
}

export interface WorkflowRow {
  id: string;
  version: number;
  owner_id: string | null;
  name: string;
  hash: string | null;
  graph: Json | null;
  triggers: Json | null;
  scope: Json | null; // ResourceSelector
  policy: Json | null;
  connection_id: string | null;
  principal: Json | null;
  state: "draft" | "published" | "disabled";
  created_at: Ms;
  published_at: Ms | null;
  disabled_at: Ms | null;
}

export interface AgentRunRow {
  id: string;
  kind: "assistant" | "workflow" | "external";
  title: string | null;
  initiator_id: string | null;
  principal: Json | null; // AgentPrincipal
  agent_id: string | null;
  agent_version: number | null;
  workflow_id: string | null;
  workflow_version: number | null;
  connection_id: string | null;
  scope: Json | null;
  policy: Json | null;
  policy_hash: string | null;
  tools_hash: string | null;
  state: RunState;
  budget: Json | null;
  usage: Json | null;
  reserved: Json | null; // budget reserved by child runs
  trigger: Json | null;
  parent_run_id: string | null;
  resource_key: string | null;
  deadline_at: Ms | null;
  cancel_requested_at: Ms | null;
  created_at: Ms;
  updated_at: Ms;
  finished_at: Ms | null;
  error: string | null;
}

export interface AgentStepRow {
  id: string;
  run_id: string;
  seq: number;
  kind: StepKind;
  name: string | null;
  depends: Json | null; // step ids
  attempt: number;
  retry_safe: Flag;
  idempotency_key: string | null;
  state: StepState;
  lease_owner: string | null;
  lease_until: Ms | null;
  fence: number;
  wake_at: Ms | null;
  input: Json | null;
  result: Json | null;
  error: string | null;
  operation_id: string | null;
  grant_id: string | null;
  created_at: Ms;
  updated_at: Ms;
}

export interface AgentModelCallRow {
  id: string;
  run_id: string;
  step_id: string | null;
  connection_id: string | null;
  provider: string | null;
  model: string | null;
  request_id: string | null;
  state: "completed" | "incomplete" | "failed";
  usage: Json | null;
  cost_estimate: number | null;
  transcript: string | null; // sealed, redacted
  started_at: Ms;
  finished_at: Ms | null;
  error: string | null;
}

export interface ApprovalGrantRow {
  id: string;
  run_id: string | null;
  step_id: string | null;
  principal: Json | null;
  operation: string;
  op_version: string | null;
  targets: Json | null;
  input_hash: string | null;
  plan_hash: string | null;
  artifact_hashes: Json | null;
  preconditions: Json | null;
  policy_hash: string | null;
  limits: Json | null;
  approval_id: string | null;
  requested_at: Ms;
  expires_at: Ms | null;
  decision: "approved" | "rejected" | null;
  decided_by: string | null;
  decided_at: Ms | null;
  reason: string | null;
  invalidated_at: Ms | null;
  invalidation_reason: string | null;
  consumed_at: Ms | null;
  consumed_operation_id: string | null;
}

export interface AgentTokenRow {
  id: string;
  kind: "run" | "external";
  name: string | null;
  owner_id: string | null;
  definition_id: string | null;
  definition_version: number | null;
  run_id: string | null;
  principal: Json | null;
  policy_hash: string | null;
  hash: string; // sha256 of the token; the token itself is never stored
  prefix: string;
  scope: Json | null;
  uses: number;
  created_at: Ms;
  last_used_at: Ms | null;
  expires_at: Ms | null;
  revoked_at: Ms | null;
}

export interface EventRow {
  seq: number; // replay cursor (SSE id / Last-Event-ID)
  at: Ms;
  type: string;
  topic: string | null;
  run_id: string | null;
  actor: string | null;
  audience: Json | null;
  payload: Json | null;
}

export interface OutboxRow {
  id: string;
  event_seq: number | null;
  target: string;
  state: string; // "pending" | "delivered" | "failed" | "dead"
  attempts: number;
  next_at: Ms | null;
  last_error: string | null;
  created_at: Ms;
  delivered_at: Ms | null;
}

export interface TriggerFireRow {
  dedupe_key: string;
  workflow_id: string;
  workflow_version: number | null;
  run_id: string | null;
  at: Ms;
}

export interface ScheduleRow {
  id: string;
  workflow_id: string;
  workflow_version: number | null;
  cron: string;
  tz: string | null;
  next_at: Ms | null;
  last_fired_at: Ms | null;
  enabled: Flag;
  created_at: Ms;
}
