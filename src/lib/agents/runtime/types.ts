// Local agent runtimes: an official CLI the person already uses (Claude Code, Gemini CLI) run unmodified as a client of
// the console's own MCP endpoint with a run-scoped `da_` token. The CLI holds the person's subscription login; the
// console never sees it, and the CLI never sees an AWS credential. Every tool call it makes is an MCP call the console
// checks against the run's policy and records itself (onAgentInvoke), so nothing the CLI prints can grant or fake a
// change. Pure types, shared by the adapters (src/lib/server/agents/runtime/) and the runner (c-runner).

export type RuntimeKind = "claude-code" | "gemini-cli";
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["claude-code", "gemini-cli"];

// The connection provider names (agent_connections.provider) that select a runtime: "runtime:claude-code", …
export const runtimeKindOf = (provider: string): RuntimeKind | undefined => {
  const k = provider.startsWith("runtime:") ? provider.slice("runtime:".length) : "";
  return (RUNTIME_KINDS as readonly string[]).includes(k) ? (k as RuntimeKind) : undefined;
};

export interface RuntimeAvailability {
  ok: boolean;
  version?: string;
  path?: string; // the resolved binary (an absolute path)
  why?: string; // when not ok: what to install or set (CONSOLE_CLAUDE_BIN, a newer Gemini CLI, …)
}

// Why a run failed, for the runner: quota and budget pause the run (paused_budget), auth pauses it (paused_auth) and
// asks the person to sign in to the CLI again — never a fallback to another connection or to API billing.
export type RuntimeErrorKind =
  | "unavailable" // binary missing, wrong version, couldn't start
  | "auth" // the CLI isn't signed in, or its login was refused
  | "quota" // the subscription's usage limit
  | "budget" // --max-budget-usd reached
  | "deadline" // the run's wall-time limit
  | "tools" // the CLI exposed or called a tool outside the allowlist
  | "mcp" // the CLI couldn't reach the console's MCP endpoint
  | "runtime"; // anything else the CLI reported

// Events as the run goes; tool_use / tool_result are what the CLI says it did, for the live view only — the console's
// own record of every call is written server-side when the MCP call arrives.
export type RuntimeEvent =
  | { type: "queued"; at: number; ahead: number } // waiting for a free runtime slot (CONSOLE_RUNTIME_CONCURRENCY)
  | { type: "started"; at: number; pid?: number; version?: string }
  // auth: where the CLI's model access comes from as it reports it (Claude Code's apiKeySource: "none" = the person's
  // subscription login; anything else names the API key or helper that pays)
  | { type: "init"; at: number; tools: string[]; model?: string; mcp: { name: string; status: string }[]; auth?: string }
  | { type: "text"; at: number; text: string }
  | { type: "tool_use"; at: number; id?: string; name: string }
  | { type: "tool_result"; at: number; id?: string; isError: boolean }
  | { type: "retry"; at: number; attempt: number; status?: number; error?: string } // the CLI retrying its model API
  | { type: "usage"; at: number; costUsd?: number; inputTokens?: number; outputTokens?: number; turns?: number; durationMs?: number };

export interface RuntimeUsage {
  costUsd?: number; // as the CLI reports it; for a subscription this is an estimate, never a bill
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  durationMs?: number;
}

export interface RuntimeRunOptions {
  prompt: string;
  mcpUrl: string; // the console's /api/mcp, as the CLI should reach it (consoleMcpUrl() in the registry)
  token: string; // the run-scoped da_ token; written only to a 0600 file the CLI reads
  model?: string;
  budgetUsd?: number;
  // When the run must end: an absolute epoch-ms time (agent_runs.deadline_at). A value below 1e12 is read as a
  // duration from now, so both "deadline_at" and "10 minutes" work.
  deadlineMs: number;
  signal: AbortSignal; // cancel: the whole process group is killed
  onEvent(e: RuntimeEvent): void; // must not throw (a throwing listener is ignored)
}

export interface RuntimeResult {
  state: "completed" | "failed" | "cancelled";
  text?: string; // the final answer (completed) — model output, untrusted
  error?: string; // why it failed, never a token
  errorKind?: RuntimeErrorKind;
  usage?: RuntimeUsage;
  version?: string; // the CLI version that ran
  tools?: string[]; // the init tool list the CLI exposed (recorded with the run)
}

export interface RuntimeAdapter {
  kind: RuntimeKind;
  label: string;
  available(): Promise<RuntimeAvailability>;
  run(opts: RuntimeRunOptions): Promise<RuntimeResult>;
}

// What a failed runtime run does to the agent run: quota and budget pause it until the person acts, a refused login
// pauses it for re-authentication; everything else fails. No kind ever falls back to another connection.
export function runStateForRuntimeError(kind: RuntimeErrorKind | undefined): "paused_budget" | "paused_auth" | "failed" {
  if (kind === "quota" || kind === "budget") return "paused_budget";
  if (kind === "auth") return "paused_auth";
  return "failed";
}

// deadlineMs → an absolute epoch-ms deadline (see RuntimeRunOptions.deadlineMs).
export const absoluteDeadline = (deadlineMs: number, now = Date.now()) => (deadlineMs < 1e12 ? now + Math.max(0, deadlineMs) : deadlineMs);
