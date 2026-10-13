// Reading what a local runtime CLI prints: newline-delimited JSON events (Claude Code's `--output-format stream-json
// --verbose`, Gemini CLI's `--output-format stream-json`), turned into RuntimeEvents for the run's live view and, at the
// end, into the run's outcome. Pure and incremental — the server adapters feed it stdout chunks as they arrive.
//
// Nothing here is trusted for what the console records: tool calls reach the run record server-side, when the MCP call
// arrives (onAgentInvoke). The parser's jobs are the safety checks (the tool allowlist, the MCP connection) and an
// honest outcome: "completed" only when the CLI itself reported success, never because the process exited 0.
import type { RuntimeErrorKind, RuntimeEvent, RuntimeResult, RuntimeUsage } from "./types.ts";
import { CLAUDE_TOOL_PREFIX, MCP_SERVER_NAME, unexpectedTools } from "./claude-args.ts";
import { scrub } from "./env.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Lines

export const MAX_LINE = 4 * 1024 * 1024; // one event; a longer line is an error, never buffered without bound
export const MAX_TEXT = 64 * 1024; // the final answer kept on the run
export const MAX_EVENT_TEXT = 8 * 1024; // one text event in the live view

// Splits a byte stream (already decoded as UTF-8 by the caller's StringDecoder) into complete lines. A line longer than
// `max` throws — the caller kills the process and fails the run rather than buffer it.
export function lineReader(max = MAX_LINE) {
  let buf = "";
  return {
    push(chunk: string): string[] {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      if (buf.length > max) throw new Error(`the CLI printed a line longer than ${max} bytes`);
      return lines.filter((l) => l.trim());
    },
    end(): string[] {
      const last = buf;
      buf = "";
      return last.trim() ? [last] : [];
    },
  };
}

// A line → its JSON object, or undefined (a CLI may print a plain-text warning between events; it is ignored).
export function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

// What the CLI said went wrong, read as words: some failures only show up as text (an error result, stderr).
const AUTH_TEXT = /\b(?:failed to authenticate|authentication[_ ]failed|invalid (?:api key|x-api-key|bearer token)|oauth (?:access )?token (?:has expired|is invalid|expired)|not logged in|please run \/login|\/login to|login required|unauthenticated|credentials? (?:are |is )?(?:missing|invalid|expired))\b/i;
const QUOTA_TEXT = /\b(?:usage limit|limit reached|hit your (?:usage )?limit|rate[_ ]limit(?:ed)?|quota|resource[_ ]exhausted|out of (?:extra )?usage|credit balance is too low|billing[_ ]error)\b/i;

export function errorKindFromText(text: string | undefined): RuntimeErrorKind | undefined {
  if (!text) return undefined;
  if (AUTH_TEXT.test(text)) return "auth";
  if (QUOTA_TEXT.test(text)) return "quota";
  return undefined;
}

export function errorKindFromStatus(status: number | undefined): RuntimeErrorKind | undefined {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  return undefined;
}

interface Exit {
  code: number | null;
  stderr?: string; // the tail of what the CLI wrote to stderr (scrubbed before it reaches a result)
}

type Outcome = Pick<RuntimeResult, "state" | "text" | "error" | "errorKind" | "usage">;
const failed = (errorKind: RuntimeErrorKind, error: string, usage?: RuntimeUsage): Outcome => ({ state: "failed", errorKind, error: scrub(error, 500), usage });

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code (`claude -p … --output-format stream-json --verbose`)
//
//   {"type":"system","subtype":"init","tools":[…],"mcp_servers":[{"name","status"}],"model","apiKeySource","claude_code_version",…}
//   {"type":"system","subtype":"api_retry","attempt","error_status","error"}
//   {"type":"assistant","message":{"content":[{"type":"text","text"}|{"type":"tool_use","id","name","input"}|…]},"error"?}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","is_error"}]}}
//   {"type":"result","subtype":"success"|"error_max_turns"|"error_during_execution"|"error_max_budget_usd",
//    "is_error","result","api_error_status"?,"total_cost_usd","usage","num_turns","duration_ms","permission_denials"}
// Recorded examples: fixtures/claude-*.jsonl. A result can say subtype "success" with is_error true (a model API error
// the CLI turned into a message): only is_error false counts.

export interface ClaudeState {
  init?: { tools: string[]; model?: string; version?: string; mcp: { name: string; status: string }[]; auth?: string };
  texts: string[];
  textBytes: number;
  toolCalls: { id?: string; name: string }[];
  apiError?: { error?: string; text?: string; status?: number };
  result?: { subtype: string; isError: boolean; text?: string; status?: number; usage: RuntimeUsage; denials: string[] };
  // Set by claudeStep when the run must stop now: the caller kills the process group, and the outcome is this failure.
  fatal?: { kind: RuntimeErrorKind; error: string };
}

export const newClaudeState = (): ClaudeState => ({ texts: [], textBytes: 0, toolCalls: [] });

// The console's MCP server as the CLI reports it: anything but connected (or still connecting) means the CLI would
// answer without the console's tools — fail instead of returning a tool-less guess.
const MCP_OK = new Set(["connected", "pending"]);

function claudeUsage(e: Record<string, unknown>): RuntimeUsage {
  const u = obj(e.usage) ?? {};
  const input = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].reduce<number | undefined>((a, v) => (num(v) === undefined ? a : (a ?? 0) + (v as number)), undefined);
  return { costUsd: num(e.total_cost_usd), inputTokens: input, outputTokens: num(u.output_tokens), turns: num(e.num_turns), durationMs: num(e.duration_ms) };
}

const isConsoleTool = (name: string) => name.startsWith(CLAUDE_TOOL_PREFIX) && name.length > CLAUDE_TOOL_PREFIX.length;

export function claudeStep(s: ClaudeState, e: Record<string, unknown>, at: number): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const type = str(e.type);
  if (type === "system" && e.subtype === "init") {
    const tools = Array.isArray(e.tools) ? e.tools.map((t) => (typeof t === "string" ? t : JSON.stringify(t))) : [];
    const mcp = (Array.isArray(e.mcp_servers) ? e.mcp_servers : []).map((m) => ({ name: String(obj(m)?.name ?? ""), status: String(obj(m)?.status ?? "") }));
    s.init = { tools, model: str(e.model), version: str(e.claude_code_version), mcp, auth: str(e.apiKeySource) };
    out.push({ type: "init", at, tools, model: s.init.model, mcp, auth: s.init.auth });
    const bad = unexpectedTools(tools);
    if (bad.length) s.fatal ??= { kind: "tools", error: `runtime exposed unexpected tools: ${bad.slice(0, 20).join(", ")}` };
    const server = mcp.find((m) => m.name === MCP_SERVER_NAME);
    if (!server || !MCP_OK.has(server.status))
      s.fatal ??= { kind: "mcp", error: `the CLI couldn't connect to the console's MCP endpoint (${server ? `status: ${server.status || "unknown"}` : "server not loaded"})` };
    return out;
  }
  if (type === "system" && e.subtype === "api_retry") {
    out.push({ type: "retry", at, attempt: num(e.attempt) ?? 0, status: num(e.error_status), error: str(e.error) });
    return out;
  }
  if (type === "assistant") {
    const content = obj(e.message)?.content;
    for (const b of Array.isArray(content) ? content : []) {
      const block = obj(b);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        if (e.error === undefined) {
          s.texts.push(block.text);
          s.textBytes += block.text.length;
        }
        out.push({ type: "text", at, text: clip(block.text, MAX_EVENT_TEXT) });
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "");
        const id = str(block.id);
        s.toolCalls.push({ id, name });
        out.push({ type: "tool_use", at, id, name });
        // The init list is the gate; this is the belt: a call to anything else stops the run at once.
        if (!isConsoleTool(name)) s.fatal ??= { kind: "tools", error: `runtime called a tool outside the allowlist: ${clip(name, 100)}` };
      }
    }
    if (typeof e.error === "string") {
      const text = Array.isArray(content) ? content.map((b) => str(obj(b)?.text) ?? "").join(" ").trim() : undefined;
      s.apiError = { error: e.error, text: text || undefined, status: s.apiError?.status };
    }
    return out;
  }
  if (type === "user") {
    const content = obj(e.message)?.content;
    for (const b of Array.isArray(content) ? content : []) {
      const block = obj(b);
      if (block?.type === "tool_result") out.push({ type: "tool_result", at, id: str(block.tool_use_id), isError: block.is_error === true });
    }
    return out;
  }
  if (type === "result") {
    const usage = claudeUsage(e);
    const denials = (Array.isArray(e.permission_denials) ? e.permission_denials : []).map((d) => String(obj(d)?.tool_name ?? "")).filter(Boolean);
    s.result = { subtype: str(e.subtype) ?? "", isError: e.is_error === true, text: str(e.result), status: num(e.api_error_status), usage, denials };
    if (s.result.status !== undefined) s.apiError = { ...s.apiError, status: s.result.status };
    out.push({ type: "usage", at, ...usage });
    return out;
  }
  return out;
}

// The assistant API error codes Claude Code puts on a synthetic message (`"error": "…"`).
const CLAUDE_ERROR_KIND: Record<string, RuntimeErrorKind> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  billing_error: "quota",
  rate_limit: "quota",
};

export function claudeOutcome(s: ClaudeState, exit: Exit): Outcome {
  const usage = s.result?.usage;
  if (s.fatal) return failed(s.fatal.kind, s.fatal.error, usage);
  const r = s.result;
  if (!r) {
    const kind = errorKindFromText(exit.stderr) ?? "runtime";
    const tail = scrub(exit.stderr ?? "", 300).trim();
    return failed(kind, `the CLI exited${exit.code === null ? "" : ` with code ${exit.code}`} without a result${tail ? `: ${tail}` : ""}`);
  }
  // Fail closed: a run whose tool list was never shown can't be shown to have kept to the allowlist.
  if (!s.init) return failed("tools", "the CLI never reported its tool list (no init event)", usage);
  // The console's own tools refused by the CLI's permission check means the allow rule didn't take: the answer was
  // written without the console, so it isn't a completed run (use the server-level rule, CLAUDE_SERVER_RULE).
  const refused = [...new Set(r.denials.filter(isConsoleTool))];
  if (refused.length) return failed("tools", `the CLI's permission check refused the console's tools (${refused.slice(0, 10).join(", ")}): its --allowedTools rule wasn't accepted`, usage);
  if (r.subtype === "success" && !r.isError) {
    if (exit.code !== 0) return failed("runtime", `the CLI reported success but exited with code ${exit.code}`, usage);
    // A server still "pending" at init passes the init check; if its tools never showed up (none listed, none called),
    // the answer was written without the console — a guess, not a completed run.
    if (!s.init.tools.some(isConsoleTool) && !s.toolCalls.some((c) => isConsoleTool(c.name)))
      return failed("mcp", "the CLI answered without the console's tools (its MCP server never finished connecting)", usage);
    return { state: "completed", text: clip(r.text ?? s.texts.join("\n\n"), MAX_TEXT), usage };
  }
  if (r.subtype === "error_max_budget_usd") return failed("budget", "the run reached its --max-budget-usd limit", usage);
  if (r.subtype === "error_max_turns") return failed("runtime", "the CLI reached its turn limit", usage);
  // From here the result is an error, so its text is the CLI's error message, not an answer that might mention limits.
  const said = r.text || s.apiError?.text || "";
  const kind =
    errorKindFromStatus(r.status ?? s.apiError?.status) ??
    (s.apiError?.error ? CLAUDE_ERROR_KIND[s.apiError.error] : undefined) ??
    errorKindFromText(said) ??
    errorKindFromText(exit.stderr);
  if (kind === "auth") return failed("auth", `the CLI's login was refused — sign in to Claude Code again (run \`claude\` and /login)${said ? `: ${said}` : ""}`, usage);
  if (kind === "quota") return failed("quota", `the subscription's usage limit was reached${said ? `: ${said}` : ""}`, usage);
  return failed("runtime", said || `the CLI ended with ${r.subtype || "an error"}`, usage);
}

// ---------------------------------------------------------------------------------------------------------------------
// Gemini CLI (`gemini -p … --output-format stream-json`, 0.11 and later)
//
//   {"type":"init","session_id","model","timestamp"}
//   {"type":"message","role":"user"|"assistant","content","delta"?}
//   {"type":"tool_use","tool_name","tool_id","parameters"}
//   {"type":"tool_result","tool_id","status":"success"|"error","output"?,"error"?:{type,message}}
//   {"type":"error","severity":"warning"|"error","message"}
//   {"type":"result","status":"success"|"error","error"?:{type,message},"stats"?:{total_tokens,input_tokens,output_tokens,duration_ms,tool_calls}}
// Gemini has no init tool list, so the allowlist is the generated settings (built-in tools excluded, only the console's
// MCP server allowed) plus this check of every tool_use. Its MCP tools are named mcp_<server>_<tool> (older versions:
// <server>__<tool>).

export const GEMINI_TOOL_PREFIXES = [`mcp_${MCP_SERVER_NAME}_`, `${MCP_SERVER_NAME}__`] as const;
export const isGeminiConsoleTool = (name: string) => GEMINI_TOOL_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);

export interface GeminiState {
  init?: { model?: string };
  texts: string[];
  toolCalls: { id?: string; name: string }[];
  errors: string[];
  result?: { status: string; error?: { type?: string; message?: string }; usage: RuntimeUsage };
  fatal?: { kind: RuntimeErrorKind; error: string };
}

export const newGeminiState = (): GeminiState => ({ texts: [], toolCalls: [], errors: [] });

export function geminiStep(s: GeminiState, e: Record<string, unknown>, at: number): RuntimeEvent[] {
  const type = str(e.type);
  if (type === "init") {
    s.init = { model: str(e.model) };
    return [{ type: "init", at, tools: [], model: s.init.model, mcp: [] }];
  }
  if (type === "message" && e.role === "assistant" && typeof e.content === "string" && e.content) {
    // Deltas are pieces of one answer; whole messages are separate paragraphs.
    if (e.delta === true && s.texts.length) s.texts[s.texts.length - 1] += e.content;
    else s.texts.push(e.content);
    return [{ type: "text", at, text: clip(e.content, MAX_EVENT_TEXT) }];
  }
  if (type === "tool_use") {
    const name = String(e.tool_name ?? "");
    const id = str(e.tool_id);
    s.toolCalls.push({ id, name });
    if (!isGeminiConsoleTool(name)) s.fatal ??= { kind: "tools", error: `runtime called a tool outside the allowlist: ${clip(name, 100)}` };
    return [{ type: "tool_use", at, id, name }];
  }
  if (type === "tool_result") return [{ type: "tool_result", at, id: str(e.tool_id), isError: e.status !== "success" }];
  if (type === "error") {
    if (typeof e.message === "string") s.errors.push(clip(e.message, 500));
    return [];
  }
  if (type === "result") {
    const st = obj(e.stats) ?? {};
    const usage: RuntimeUsage = { inputTokens: num(st.input_tokens), outputTokens: num(st.output_tokens), durationMs: num(st.duration_ms) };
    const err = obj(e.error);
    s.result = { status: str(e.status) ?? "", error: err ? { type: str(err.type), message: str(err.message) } : undefined, usage };
    return [{ type: "usage", at, ...usage }];
  }
  return [];
}

// Gemini CLI exit codes: 0 success, 1 error, 42 bad input, 53 turn limit.
export function geminiOutcome(s: GeminiState, exit: Exit): Outcome {
  const usage = s.result?.usage;
  if (s.fatal) return failed(s.fatal.kind, s.fatal.error, usage);
  const r = s.result;
  if (r?.status === "success" && exit.code === 0) return { state: "completed", text: clip(s.texts.join("\n\n"), MAX_TEXT), usage };
  if (exit.code === 53) return failed("runtime", "the CLI reached its turn limit", usage);
  const said = [r?.error?.type, r?.error?.message, ...s.errors].filter(Boolean).join(": ");
  const kind = errorKindFromText(said) ?? errorKindFromText(exit.stderr);
  if (kind === "auth") return failed("auth", `the Gemini CLI's login was refused — sign in again (run \`gemini\`)${said ? `: ${said}` : ""}`, usage);
  if (kind === "quota") return failed("quota", `the Gemini quota was reached${said ? `: ${said}` : ""}`, usage);
  if (!r) {
    const tail = scrub(exit.stderr ?? "", 300).trim();
    return failed("runtime", `the CLI exited${exit.code === null ? "" : ` with code ${exit.code}`} without a result${tail ? `: ${tail}` : ""}`);
  }
  return failed("runtime", said || `the CLI ended with status ${r.status || "unknown"} (exit code ${exit.code})`, usage);
}
