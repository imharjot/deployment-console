// The Gemini CLI as a local agent runtime: how it is started and the workspace settings it reads. Pure.
//
// Gemini CLI reads MCP servers from settings files; the run writes `.gemini/settings.json` into its own empty working
// directory (workspace settings override the person's ~/.gemini/settings.json for every key set here):
//   mcpServers.deployment-console   the console's /api/mcp over HTTP with the run's da_ token (`httpUrl` + `headers`),
//                                   trusted so its tools run without a confirmation nobody could answer
//   mcp.allowed                     only that server, whatever the person's own settings list
//   tools.core = [] / tools.exclude no built-in tools (shell, file edits, web fetch, search, memory)
//   telemetry, usage statistics, auto-update and YOLO mode off
// and is started with:
//   -p <prompt>                          headless: one task, then exit
//   --output-format stream-json          one JSON event per line (0.11 and later)
//   --approval-mode default              anything that would need a confirmation is refused (no TTY, no YOLO)
//   --allowed-mcp-server-names deployment-console
//   -e none                              no extensions
// Gemini reports no tool list at start, so every tool_use event is checked as it arrives (stream-json.ts); anything
// outside the console's MCP namespace kills the run. The installed 0.1.5 has none of this: available() says so.
import { MCP_SERVER_NAME } from "./claude-args.ts";
import { MODEL_NAME, promptArg } from "./env.ts";

export const MIN_GEMINI_VERSION = "0.11.0"; // stream-json output; HTTP MCP with headers came earlier

// Built-in tools of recent Gemini CLI versions — excluded by name as well as by the empty core list, so a version
// that reads `tools.core: []` as "no restriction" still loads none of them.
export const GEMINI_BUILTIN_TOOLS = [
  "run_shell_command",
  "write_file",
  "replace",
  "smart_edit",
  "read_file",
  "read_many_files",
  "glob",
  "search_file_content",
  "list_directory",
  "web_fetch",
  "google_web_search",
  "save_memory",
  "write_todos",
  "codebase_investigator",
  "delegate_to_agent",
  "activate_skill",
] as const;

// Flags `gemini --help` must show for the runtime to work as described above.
export const GEMINI_REQUIRED_HELP = ["stream-json", "--approval-mode", "--allowed-mcp-server-names", "--extensions"] as const;

export function geminiArgs(o: { prompt: string; model?: string }): string[] {
  if (o.model !== undefined && (typeof o.model !== "string" || !MODEL_NAME.test(o.model))) throw new Error("invalid model name");
  return [
    "-p",
    promptArg(o.prompt),
    "--output-format",
    "stream-json",
    "--approval-mode",
    "default",
    "--allowed-mcp-server-names",
    MCP_SERVER_NAME,
    "-e",
    "none",
    ...(o.model ? ["-m", o.model] : []),
  ];
}

// The workspace `.gemini/settings.json` (written 0600 in the run's 0700 directory, deleted with it).
export function geminiSettings(mcpUrl: string, token: string) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: { httpUrl: mcpUrl, headers: { Authorization: `Bearer ${token}` }, trust: true, timeout: 120_000 },
    },
    mcp: { allowed: [MCP_SERVER_NAME] },
    tools: { core: [] as string[], exclude: [...GEMINI_BUILTIN_TOOLS] as string[] },
    general: { enableAutoUpdate: false, disableAutoUpdate: true, checkpointing: { enabled: false } },
    security: { disableYoloMode: true },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
    context: { includeDirectories: [] as string[] },
  };
}

// Environment additions for Gemini: the run's own directory is the workspace, and it is trusted (it holds only the
// settings above) — otherwise folder trust would ignore the workspace settings and the console's server with them.
export const GEMINI_ENV = { GEMINI_CLI_TRUST_WORKSPACE: "true", NO_COLOR: "1" } as const;

// "0.1.5" or "gemini 0.12.0" → "0.12.0".
export function parseGeminiVersion(out: string): string | undefined {
  const m = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(out ?? "");
  return m ? m[1] : undefined;
}

// Which required flags a `gemini --help` text lacks.
export const missingGeminiFeatures = (help: string) => GEMINI_REQUIRED_HELP.filter((f) => !String(help ?? "").includes(f));

export const geminiTooOld = (version: string | undefined) =>
  `Gemini CLI ${version ?? "(unknown version)"} is too old for HTTP MCP (needs ${MIN_GEMINI_VERSION} or newer: npm install -g @google/gemini-cli@latest)`;
