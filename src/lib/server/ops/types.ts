// The operation contract. Every capability an agent (or any API client) can use is one Operation: a stable name, a
// description written for a language model, a JSON Schema for its input, a risk level and the permission it needs.
// The registry (./index.ts) validates input, checks permissions, applies token modes and approvals, then calls run().
// Operations call the same server functions the UI routes call, so every guard, lock and audit row still applies.
import type { AgentPrincipal } from "../../agents/types.ts";
import type { Perm, User } from "../../rbac.ts";

// read:   no side effects.
// change: alters running state within what already exists, and can be undone (restart, scale within the cap, edit
//         variables, a one-off task of the task definition's own command).
// danger: destructive, irreversible, starts new paying resources or runs a command someone typed (delete a service,
//         terminate a host, copy a service, add hosts, a one-off task with a command override). For API tokens,
//         danger always needs a person's approval, whatever the token's mode.
export type Risk = "read" | "change" | "danger";

// The subset of JSON Schema the registry validates (and that LLM tool-calling APIs accept).
export interface JsonSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  maxItems?: number;
  default?: unknown;
  // For forms (the registry validates none of these; MCP and the API pass them through untouched):
  title?: string; // the label people see on a form (F42); `description` stays the hint for agents
  "x-group"?: string; // on a property: shown only when the input's "x-groups" choice is this group
  // On the input: one way of giving the input at a time (Lambda's code: a .zip upload, a .zip in S3 or an image). A
  // group is offered when the resource's prop `ifProp` has that value, and not when `unlessProp` does.
  "x-groups"?: { id: string; title: string; ifProp?: { label: string; value: string }; unlessProp?: { label: string; value: string } }[];
  "x-echo"?: boolean; // on a property: filled from the dry run's plan.echo, never typed by a person (R04)
}

export interface OpContext {
  user: User; // permission checks run as this user (a token's role is capped by its owner's current role; an agent's is its delegator's current role)
  actor: string; // what the audit log records: `alice@acme.com`, `alice@acme.com via token "release-bot"`, `agent run 1a2b3c4d for alice@acme.com`
  ip?: string;
  via: "session" | "alb" | "dev" | "token" | "agent";
  tokenId?: string;
  tokenName?: string; // token callers only
  tokenMode?: "read" | "propose" | "act"; // token callers only — see gate() in src/lib/automation.ts
  approval?: string; // set when a person approved an API token's request; run() executes as that person
  principal?: AgentPrincipal; // agent callers: the server-built delegate (src/lib/server/agents/principals.ts)
  grantId?: string; // agent callers: the exact-plan grant this change runs under
  runId?: string; // agent callers
  stepId?: string; // agent callers inside a durable step (the idempotency key run:<runId>:step:<stepId>)
}

// What a dry run returns and what an approver reviews. Names and counts only — never secret values.
export interface Plan {
  summary: string; // one line: "Restart api in production (2 tasks, rolling)"
  changes?: string[];
  warnings?: string[];
  estimate?: { monthlyUsd: number; note: string }; // for operations that start paying resources
  // Exact text a person must type to approve (protected environments), e.g. the service name. Absent or "yes" = one
  // click. An approver's typed text replaces the input's `confirm` field when the approved operation runs.
  confirm?: string;
  // Fields the confirming request sends back in its input: the state the plan was made against, so the action refuses
  // when it has moved since (R04: an image deploy's expectedRevision).
  echo?: Record<string, unknown>;
}

export interface Operation<I = Record<string, unknown>, O = unknown> {
  name: string; // "<area>.<verb>", e.g. "services.restart" — stable; tools, approvals and audit rows refer to it
  title: string; // "Restart a service"
  description: string; // for a model: what it does, when to use it, what it returns, what it refuses
  risk: Risk;
  riskOf?: (input: I) => Risk; // when some inputs make it riskier than `risk` (a command override → danger)
  perm: Perm;
  permOf?: (input: I) => Perm | Promise<Perm>; // when the permission depends on the input (a generic cloud action)
  // When protection depends on more than the environment (a cloud resource tagged console:protected, placed in no
  // environment, or hinted protected): OR-ed with the environment's own flag everywhere the registry decides.
  protectedOf?: (input: I) => boolean | Promise<boolean>; // base permission; the protected variant applies when env(input) is a protected environment
  input: JsonSchema; // always { type: "object", ... }
  secretFields?: string[]; // input fields never shown back (approval list, audit) — e.g. variable values
  // The input as approval views and generic plans may show it, when hiding top-level fields isn't enough (a generic
  // cloud action hides the provider action's own secret fields inside `input`). Applied after secretFields.
  maskInput?: (input: I) => Record<string, unknown>;
  // The environment this touches (protected-env rules, approvals, audit). May be async when it has to be looked up
  // (a CI run's branch decides whether a re-run deploys to a protected environment).
  env?: (input: I) => string | undefined | Promise<string | undefined>;
  plan?: (input: I, ctx: OpContext) => Promise<Plan>; // dry run
  run: (input: I, ctx: OpContext) => Promise<O>;
}

// Operations are declared with their own input type; the registry stores them type-erased.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = Operation<any, unknown>;
export const defineOps = <T extends AnyOperation[]>(ops: T) => ops;
