// The local agent runtimes by kind. The runner (c-runner) uses runtimeFor() for connections whose provider is
// "runtime:claude-code" or "runtime:gemini-cli": one model step runs the CLI with the run's token, and the console
// records the CLI's MCP calls as they arrive. The connection test (c-credentials-connections) asks available().
// A runtime never falls back to another runtime, connection or provider.
import "server-only";
import { consoleMcpUrl as mcpUrlFrom } from "../../../agents/runtime/env.ts";
import { RUNTIME_KINDS, runtimeKindOf, type RuntimeAdapter, type RuntimeAvailability, type RuntimeKind } from "../../../agents/runtime/types.ts";
import { claudeCodeRuntime } from "./claude-code.ts";
import { geminiCliRuntime } from "./gemini-cli.ts";

const ADAPTERS: Record<RuntimeKind, RuntimeAdapter> = { "claude-code": claudeCodeRuntime, "gemini-cli": geminiCliRuntime };

export function runtimeFor(kind: RuntimeKind): RuntimeAdapter {
  if (!Object.hasOwn(ADAPTERS, kind)) throw new Error(`unknown runtime: ${String(kind).slice(0, 40)}`);
  return ADAPTERS[kind];
}

// "runtime:claude-code" → the Claude Code adapter; any other provider → undefined.
export function runtimeForProvider(provider: string): RuntimeAdapter | undefined {
  const kind = runtimeKindOf(provider);
  return kind ? ADAPTERS[kind] : undefined;
}

// The console's /api/mcp as the CLI on this machine reaches it (CONSOLE_PUBLIC_URL, else loopback on PORT).
export const consoleMcpUrl = () => mcpUrlFrom(process.env);

// Every runtime's availability, for the Connections screen and the docs' compatibility notes.
export async function runtimeStatus(): Promise<Record<RuntimeKind, RuntimeAvailability>> {
  const entries = await Promise.all(RUNTIME_KINDS.map(async (k) => [k, await ADAPTERS[k].available()] as const));
  return Object.fromEntries(entries) as Record<RuntimeKind, RuntimeAvailability>;
}

export { RUNTIME_KINDS, runtimeKindOf };
export type { RuntimeAdapter, RuntimeAvailability, RuntimeKind };
