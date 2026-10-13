// The person's own, unmodified Claude Code CLI as an agent runtime (master plan decision 11, AGENT_ARCHITECTURE §5:
// Anthropic allows hosting the unmodified binary with the person's own login; the console never collects or proxies
// a Claude.ai credential). The CLI is only an MCP client of the console: it reaches /api/mcp with the run's da_ token,
// and every tool call is checked against the run's policy and recorded server-side. The flags are in
// src/lib/agents/runtime/claude-args.ts; the stream parsing and the tool allowlist in stream-json.ts.
import "server-only";
import os from "node:os";
import path from "node:path";
import { MIN_CLAUDE_VERSION, claudeArgs, claudeMcpConfig, compareVersions, parseClaudeVersion } from "../../../agents/runtime/claude-args.ts";
import { runtimeEnv, scrub } from "../../../agents/runtime/env.ts";
import { claudeOutcome, claudeStep, newClaudeState } from "../../../agents/runtime/stream-json.ts";
import type { RuntimeAdapter, RuntimeAvailability, RuntimeRunOptions } from "../../../agents/runtime/types.ts";
import { cachedAvailability, resolveBinary, runCli, runCommand } from "./process.ts";

export const CLAUDE_BIN_ENV = "CONSOLE_CLAUDE_BIN";

async function probe(): Promise<RuntimeAvailability> {
  const bin = await resolveBinary({ envVar: CLAUDE_BIN_ENV, name: "claude", fallbacks: [path.join(os.homedir(), ".local", "bin", "claude")], label: "Claude Code" });
  if ("why" in bin) return { ok: false, why: bin.why };
  const r = await runCommand(bin.path, ["--version"]);
  const version = parseClaudeVersion(r.stdout);
  if (!version) return { ok: false, path: bin.path, why: `couldn't read the version of ${bin.path}${r.error ? `: ${r.error}` : ""}${r.stderr ? `: ${scrub(r.stderr, 200)}` : ""}` };
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0)
    return { ok: false, version, path: bin.path, why: `Claude Code ${version} is older than ${MIN_CLAUDE_VERSION}, which the console needs (--restricted, --permission-prompts); update it with \`claude update\`` };
  return { ok: true, version, path: bin.path };
}

export const claudeCodeRuntime: RuntimeAdapter = {
  kind: "claude-code",
  label: "Claude Code (local CLI)",
  available: () => cachedAvailability(`claude-code:${process.env[CLAUDE_BIN_ENV] ?? ""}`, probe),
  run: (o: RuntimeRunOptions) =>
    runCli(o, {
      prefix: "dc-claude-",
      available: claudeCodeRuntime.available,
      async prepare(dir, input) {
        const file = await dir.writeSecret("mcp.json", JSON.stringify(claudeMcpConfig(input.mcpUrl, input.token)));
        return { args: claudeArgs({ prompt: input.prompt, mcpConfigFile: file, model: input.model, budgetUsd: input.budgetUsd }), env: runtimeEnv(process.env, { tmpDir: dir.tmp }) };
      },
      newState: newClaudeState,
      step: claudeStep,
      fatal: (s) => !!s.fatal,
      outcome: claudeOutcome,
      tools: (s) => s.init?.tools,
    }),
};
