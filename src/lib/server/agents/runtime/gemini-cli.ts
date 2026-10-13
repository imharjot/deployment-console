// The person's own Gemini CLI as an agent runtime, signed in with their Google account (AGENT_ARCHITECTURE §5: the
// official CLI supports Google AI Pro/Ultra sign-in; there is no third-party OAuth route to that quota). Like Claude
// Code it is only an MCP client of the console with the run's da_ token. It needs a version with HTTP MCP servers
// (`httpUrl` + `headers`), stream-json output and the restriction flags; anything older is reported as unavailable,
// never run. Settings and flags: src/lib/agents/runtime/gemini-args.ts.
import "server-only";
import os from "node:os";
import path from "node:path";
import { compareVersions } from "../../../agents/runtime/claude-args.ts";
import { runtimeEnv, scrub } from "../../../agents/runtime/env.ts";
import { GEMINI_ENV, MIN_GEMINI_VERSION, geminiArgs, geminiSettings, geminiTooOld, missingGeminiFeatures, parseGeminiVersion } from "../../../agents/runtime/gemini-args.ts";
import { geminiOutcome, geminiStep, newGeminiState } from "../../../agents/runtime/stream-json.ts";
import type { RuntimeAdapter, RuntimeAvailability, RuntimeRunOptions } from "../../../agents/runtime/types.ts";
import { cachedAvailability, resolveBinary, runCli, runCommand } from "./process.ts";

export const GEMINI_BIN_ENV = "CONSOLE_GEMINI_BIN";

async function probe(): Promise<RuntimeAvailability> {
  const bin = await resolveBinary({
    envVar: GEMINI_BIN_ENV,
    name: "gemini",
    fallbacks: ["/opt/homebrew/bin/gemini", "/usr/local/bin/gemini", path.join(os.homedir(), ".local", "bin", "gemini"), path.join(os.homedir(), ".npm-global", "bin", "gemini")],
    label: "Gemini CLI",
  });
  if ("why" in bin) return { ok: false, why: bin.why };
  const v = await runCommand(bin.path, ["--version"]);
  const version = parseGeminiVersion(v.stdout);
  if (!version) return { ok: false, path: bin.path, why: `couldn't read the version of ${bin.path}${v.error ? `: ${v.error}` : ""}${v.stderr ? `: ${scrub(v.stderr, 200)}` : ""}` };
  if (compareVersions(version, MIN_GEMINI_VERSION) < 0) return { ok: false, version, path: bin.path, why: geminiTooOld(version) };
  const help = await runCommand(bin.path, ["--help"]);
  const missing = missingGeminiFeatures(`${help.stdout}\n${help.stderr}`);
  if (missing.length) return { ok: false, version, path: bin.path, why: `${geminiTooOld(version)} — its --help lacks ${missing.join(", ")}` };
  return { ok: true, version, path: bin.path };
}

export const geminiCliRuntime: RuntimeAdapter = {
  kind: "gemini-cli",
  label: "Gemini CLI (local)",
  available: () => cachedAvailability(`gemini-cli:${process.env[GEMINI_BIN_ENV] ?? ""}`, probe),
  run: (o: RuntimeRunOptions) =>
    runCli(o, {
      prefix: "dc-gemini-",
      available: geminiCliRuntime.available,
      // Gemini CLI has no spending cap, so budgetUsd isn't passed on; the run's own limits (wall time, the console's
      // tool-call limits) still hold.
      async prepare(dir, input) {
        await dir.writeSecret(path.join("work", ".gemini", "settings.json"), JSON.stringify(geminiSettings(input.mcpUrl, input.token), null, 2));
        return { args: geminiArgs({ prompt: input.prompt, model: input.model }), env: runtimeEnv(process.env, { tmpDir: dir.tmp, extra: { ...GEMINI_ENV } }) };
      },
      newState: newGeminiState,
      step: geminiStep,
      fatal: (s) => !!s.fatal,
      outcome: geminiOutcome,
      tools: () => undefined,
    }),
};
