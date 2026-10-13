// Configuration mistakes that would make every request fail or silently do the wrong thing. The proxy refuses to serve
// (500 with the reason) and /api/healthz fails while any of them holds, so a bad deploy rolls back instead of going
// healthy — and nobody ends up on SQLite or the demo account by accident.
//
// console.config.json is loaded here too (discovery re-exports consoleConfig()): a broken file never fails open (F05).
// A re-read that fails keeps the last good parse and reports why; a file that can't be read at boot fails closed —
// every environment protected, provisioning off, unassigned resources protected — until it is fixed. Mistakes inside
// a readable file are reported by the parser and the rest of the file applies; /api/healthz says "degraded" for them.
import "server-only";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseConfig, type ConsoleConfig } from "../console-config.ts";
import { authMode } from "./auth/config.ts";
import { errText } from "./errors.ts";
import { secretKeyProblem } from "./secrets.ts";
import { sourceKind } from "./sources.ts";

export function fatalConfigProblem(): string | undefined {
  const mode = authMode();
  if (!mode.ok) return mode.error;
  const url = process.env.DATABASE_URL?.trim();
  if (url && !/^postgres(ql)?:\/\//.test(url)) return "DATABASE_URL must be a postgres:// URL — unset it to use SQLite";
  try {
    sourceKind();
  } catch (e) {
    return (e as Error).message;
  }
  return secretKeyProblem();
}

// ---------- console.config.json ----------

export interface LoadedConfig {
  file?: string;
  mtime: number;
  config: ConsoleConfig;
  errors: string[];
  failClosed?: boolean; // the file couldn't be read and nothing good was read before: everything protected
  stale?: boolean; // the file is broken now; this is the last version that could be read
}

// What the console falls back to when its config file can't be read and no good version was read before.
export const FAIL_CLOSED_CONFIG: ConsoleConfig = { provisioning: { enabled: false }, inventory: { unassignedProtected: true } };

// On globalThis: the sampler and the routes are separate bundles and must agree on what "the last good config" is.
const g = globalThis as { __consoleConfigFile?: { current?: LoadedConfig; good?: LoadedConfig } };
const S = (g.__consoleConfigFile ??= {});

// CONSOLE_CONFIG, else ./console.config.json, else (demo only) the bundled example. Re-read when the file changes.
// An empty CONSOLE_CONFIG (as in .env.example) counts as unset.
export function consoleConfig(): LoadedConfig {
  const file =
    process.env.CONSOLE_CONFIG || (existsFile("console.config.json") ? "console.config.json" : sourceKind() === "mock" ? "examples/demo.console.config.json" : undefined);
  if (!file) return (S.current = { mtime: 0, config: {}, errors: [] });
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
    if (S.current?.file === file && S.current.mtime === mtime) return S.current;
    const loaded: LoadedConfig = { file, mtime, ...parseConfig(JSON.parse(readFileSync(file, "utf8"))) };
    S.good = loaded;
    return (S.current = loaded);
  } catch (e) {
    const problem = `${path.basename(file)}: ${errText(e)}`;
    const good = S.good?.file === file ? S.good : undefined;
    // mtime stays the broken file's, so it isn't parsed again on every call (a missing file is checked each time).
    S.current = good
      ? { ...good, mtime, errors: [`${problem} — still using the version read ${new Date(good.mtime).toISOString()}`, ...good.errors], stale: true }
      : { file, mtime, config: FAIL_CLOSED_CONFIG, errors: [`${problem} — failing closed: every environment is protected and provisioning is off until it is fixed`], failClosed: true };
    return S.current;
  }
}

function existsFile(f: string): boolean {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
}

// Not fatal (the console keeps serving), but /api/healthz reports it: a real deployment whose config file has errors,
// is broken, or failed closed. The demo's simulated account never degrades for this.
export function degradedConfigProblem(): string | undefined {
  let kind: string;
  try {
    kind = sourceKind();
  } catch {
    return undefined; // fatalConfigProblem reports it
  }
  if (kind !== "aws") return undefined;
  const c = consoleConfig();
  if (!c.errors.length) return undefined;
  return `${c.failClosed ? "config failed closed" : c.stale ? "config file broken, last good version in use" : "config file has errors"}: ${c.errors.slice(0, 3).join("; ")}${c.errors.length > 3 ? `; and ${c.errors.length - 3} more` : ""}`;
}
