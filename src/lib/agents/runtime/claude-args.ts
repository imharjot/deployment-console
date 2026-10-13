// The Claude Code CLI as a local agent runtime: exactly how it is started. Pure, so the flags are tested, not trusted.
//
// The person's unmodified `claude` binary runs with:
//   -p <prompt>                       print mode: one task, then exit
//   --restricted                      no built-in tool that runs commands or code, no WebFetch; user, project and local
//                                     settings files are ignored, so the person's hooks, plugins and permission rules
//                                     don't load (managed settings still apply)
//   --tools ""                        no built-in tools at all (no Read/Edit/Write/Glob/Grep/Task/…)
//   --disable-slash-commands          no skills
//   --strict-mcp-config               only the MCP server below, none of the person's own
//   --mcp-config <file>               that server: the console's /api/mcp with the run's da_ token (a 0600 temp file)
//   --allowedTools mcp__deployment-console__*   the console's tools are pre-approved…
//   --permission-mode dontAsk         …and anything not pre-approved is denied rather than asked about
//   --permission-prompts none         nobody answers prompts: anything that would prompt is denied
//   --output-format stream-json --verbose       one JSON event per line, including the init event's tool list
//   --no-session-persistence          nothing saved to resume
// Never --bare (it drops the subscription login), --dangerously-skip-permissions or its "allow" variant, --add-dir,
// --plugin-dir/--plugin-url, --settings, --chrome or --resume. Checked against `claude --help` of 2.1.263.
import { MODEL_NAME, promptArg } from "./env.ts";

export const MCP_SERVER_NAME = "deployment-console";
export const CLAUDE_TOOL_RULE = `mcp__${MCP_SERVER_NAME}__*`;
// The server-level rule, for a CLI that rejects the wildcard (2.1.263 accepts it).
export const CLAUDE_SERVER_RULE = `mcp__${MCP_SERVER_NAME}`;
export const CLAUDE_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Claude Code adds these whenever an MCP server is configured; they only list and read resources of the configured
// servers (the console advertises none), so they are the only non-console names an init tool list may carry.
export const MCP_RESOURCE_HELPERS = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"] as const;

// Flags that must never reach the CLI, whatever a caller passes.
export const FORBIDDEN_CLAUDE_FLAGS = [
  "--bare",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--add-dir",
  "--plugin-dir",
  "--plugin-url",
  "--settings",
  "--setting-sources",
  "--chrome",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--agents",
  "--disallowedTools",
  "--permission-prompt-tool",
] as const;

export const MAX_BUDGET_USD = 1_000;

export interface ClaudeArgsInput {
  prompt: string;
  mcpConfigFile: string; // absolute path of the 0600 config file
  model?: string;
  budgetUsd?: number;
  toolRule?: typeof CLAUDE_TOOL_RULE | typeof CLAUDE_SERVER_RULE;
}

export function claudeArgs(o: ClaudeArgsInput): string[] {
  if (typeof o.mcpConfigFile !== "string" || !o.mcpConfigFile.startsWith("/") || /[\0\n]/.test(o.mcpConfigFile)) throw new Error("the MCP config file must be an absolute path");
  const rule = o.toolRule ?? CLAUDE_TOOL_RULE;
  if (rule !== CLAUDE_TOOL_RULE && rule !== CLAUDE_SERVER_RULE) throw new Error("unknown tool rule");
  if (o.model !== undefined && (typeof o.model !== "string" || !MODEL_NAME.test(o.model))) throw new Error("invalid model name");
  if (o.budgetUsd !== undefined && !(typeof o.budgetUsd === "number" && Number.isFinite(o.budgetUsd) && o.budgetUsd > 0 && o.budgetUsd <= MAX_BUDGET_USD))
    throw new Error(`the budget must be a positive number of dollars up to ${MAX_BUDGET_USD}`);
  return [
    "-p",
    promptArg(o.prompt),
    "--restricted",
    "--tools",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    o.mcpConfigFile,
    "--allowedTools",
    rule,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    ...(o.model ? ["--model", o.model] : []),
    ...(o.budgetUsd ? ["--max-budget-usd", String(o.budgetUsd)] : []),
  ];
}

// The --mcp-config document: one HTTP server, the console, with the run's bearer token. Written to a 0600 file in a
// 0700 directory and deleted with it; never placed in argv (other users can read a process's argv).
export function claudeMcpConfig(mcpUrl: string, token: string) {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
}

// The init event's tool list: only the console's MCP tools and the three resource helpers. Anything else — Bash, Read,
// Edit, Write, WebFetch, Task, Glob, Grep, NotebookEdit, another server's mcp__… — kills the run.
export function unexpectedTools(tools: readonly unknown[]): string[] {
  return tools
    .map((t) => (typeof t === "string" ? t : JSON.stringify(t)))
    .filter((t) => !(t.startsWith(CLAUDE_TOOL_PREFIX) && t.length > CLAUDE_TOOL_PREFIX.length) && !(MCP_RESOURCE_HELPERS as readonly string[]).includes(t));
}

// "2.1.263 (Claude Code)" → "2.1.263".
export function parseClaudeVersion(out: string): string | undefined {
  const m = /^\s*v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)\s*(?:\(Claude Code\))?/m.exec(out ?? "");
  return m ? m[1] : undefined;
}

// Versions known to take every flag above (--restricted, --permission-prompts and --disable-slash-commands are recent).
export const MIN_CLAUDE_VERSION = "2.1.263";
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const d = (Number.isFinite(pa[i]) ? pa[i] : 0) - (Number.isFinite(pb[i]) ? pb[i] : 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
