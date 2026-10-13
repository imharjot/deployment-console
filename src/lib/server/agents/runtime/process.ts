// Running a local runtime CLI as a child process, safely: the binary is found once (an admin-set path, PATH, or the
// installer's default), each run gets its own 0700 directory (an empty working directory, a scratch TMPDIR and the 0600
// config file holding the run token), the process starts in its own process group with a minimal environment, and the
// whole group is killed on cancel, at the run's deadline, or as soon as the output breaks a safety rule. The directory
// is always deleted afterwards. At most CONSOLE_RUNTIME_CONCURRENCY CLIs run at once (slots on globalThis, shared by
// the routes and the worker); live process groups are remembered there too and killed if the console exits.
import "server-only";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { lineReader, parseLine } from "../../../agents/runtime/stream-json.ts";
import { checkMcpUrl, isRunToken, promptArg, runtimeEnv, scrub } from "../../../agents/runtime/env.ts";
import { SlotWaitError, createSlots, runtimeConcurrency, type Slots } from "../../../agents/runtime/slots.ts";
import {
  absoluteDeadline,
  type RuntimeAvailability,
  type RuntimeErrorKind,
  type RuntimeEvent,
  type RuntimeResult,
  type RuntimeRunOptions,
} from "../../../agents/runtime/types.ts";

interface Shared {
  slots: Slots;
  live: Set<number>; // process-group ids of running CLIs
  availability: Map<string, { at: number; value: RuntimeAvailability }>;
  exitHook?: boolean;
}
const g = globalThis as { __consoleRuntimes?: Shared };
function shared(): Shared {
  const s: Shared = (g.__consoleRuntimes ??= {
    slots: createSlots(() => runtimeConcurrency(process.env.CONSOLE_RUNTIME_CONCURRENCY)),
    live: new Set<number>(),
    availability: new Map(),
  });
  if (!s.exitHook) {
    s.exitHook = true;
    // A detached group outlives the console otherwise; "exit" handlers may only do synchronous work, and kill() is.
    process.once("exit", () => {
      for (const pgid of s.live) killGroup(pgid, "SIGKILL");
    });
  }
  return s;
}

export const runtimeSlots = () => shared().slots;

// Next types NODE_ENV as required on ProcessEnv; a runtime's environment deliberately has none of the server's.
const asEnv = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

function killGroup(pgid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pgid, sig);
  } catch {
    // already gone (ESRCH)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding the binary

async function executable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

// The admin's setting (an absolute path) wins and is never second-guessed by PATH; then PATH; then the installer's
// usual places (Claude Code's native installer puts `claude` in ~/.local/bin, which a server's PATH often lacks).
export async function resolveBinary(o: { envVar: string; name: string; fallbacks: string[]; label: string }): Promise<{ path: string } | { why: string }> {
  const set = process.env[o.envVar]?.trim();
  if (set) {
    if (!path.isAbsolute(set)) return { why: `${o.envVar} must be an absolute path (it is ${JSON.stringify(set.slice(0, 200))})` };
    return (await executable(set)) ? { path: set } : { why: `${o.envVar}=${set.slice(0, 200)} is not an executable file` };
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const p = path.join(dir, o.name);
    if (await executable(p)) return { path: p };
  }
  for (const p of o.fallbacks) if (await executable(p)) return { path: p };
  return { why: `${o.label} isn't installed on the console's machine (or isn't on its PATH): set ${o.envVar} to the absolute path of \`${o.name}\`` };
}

// A short command (`--version`, `--help`) with the runtime's minimal environment, in a neutral directory.
export function runCommand(bin: string, args: string[], o: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>((resolve) => {
    execFile(
      bin,
      args,
      { cwd: os.tmpdir(), env: asEnv(o.env ?? runtimeEnv(process.env)), timeout: o.timeoutMs ?? 15_000, killSignal: "SIGKILL", maxBuffer: 1 << 20, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : null) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: e ? (e.killed ? "timed out" : scrub(e.message, 300)) : undefined,
        });
      },
    );
  });
}

// available() is asked by every connection list and test; the answer is kept a minute (a failure ten seconds).
export async function cachedAvailability(key: string, probe: () => Promise<RuntimeAvailability>): Promise<RuntimeAvailability> {
  const s = shared();
  const hit = s.availability.get(key);
  if (hit && Date.now() - hit.at < (hit.value.ok ? 60_000 : 10_000)) return hit.value;
  let value: RuntimeAvailability;
  try {
    value = await probe();
  } catch (e) {
    value = { ok: false, why: scrub(String((e as Error)?.message ?? e), 300) };
  }
  s.availability.set(key, { at: Date.now(), value });
  return value;
}

export function forgetAvailability() {
  shared().availability.clear();
}

// ---------------------------------------------------------------------------------------------------------------------
// The run's directory

export interface RunDir {
  root: string; // 0700: holds the config file, work/ and tmp/
  work: string; // the CLI's working directory: empty unless the adapter writes its workspace settings into it
  tmp: string; // the CLI's TMPDIR
  writeSecret(rel: string, content: string): Promise<string>; // a 0600 file under root; returns its absolute path
  remove(): Promise<void>;
}

export async function makeRunDir(prefix: string): Promise<RunDir> {
  // mkdtemp creates it 0700; the canonical path (macOS's /tmp is /private/tmp) is what the CLI will see as its cwd.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const work = path.join(root, "work");
  const tmp = path.join(root, "tmp");
  await mkdir(work, { mode: 0o700 });
  await mkdir(tmp, { mode: 0o700 });
  return {
    root,
    work,
    tmp,
    async writeSecret(rel, content) {
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) throw new Error("the file must be inside the run directory");
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // "wx": never follow or reuse something already there.
      await writeFile(file, content, { mode: 0o600, flag: "wx" });
      return file;
    },
    async remove() {
      for (let i = 0; i < 3; i++) {
        try {
          await rm(root, { recursive: true, force: true, maxRetries: 2 });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      console.error(JSON.stringify({ level: 40, msg: "runtime: couldn't delete a run directory", dir: root }));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The process

export const MAX_STDOUT = 32 * 1024 * 1024;
export const KILL_GRACE_MS = 3_000;
const MAX_STDERR = 16 * 1024;
const MAX_TIMER = 2 ** 31 - 1;

export type KillReason = "cancel" | "deadline" | "fatal" | "output";

export interface Spawned {
  pid?: number;
  kill(reason: KillReason): void;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; killed?: KillReason; stderr: string; spawnError?: string }>;
}

export function spawnRuntime(o: {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  deadline: number; // epoch ms
  signal: AbortSignal;
  onLine(line: string): void; // one complete stdout line; may call kill()
}): Spawned {
  const s = shared();
  const child = spawn(o.bin, o.args, { cwd: o.cwd, env: asEnv(o.env), stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
  const pgid = child.pid;
  if (pgid) s.live.add(pgid);
  let killed: KillReason | undefined;
  let exited = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (reason: KillReason) => {
    if (killed || exited || !pgid) return;
    killed = reason;
    killGroup(pgid, "SIGTERM");
    graceTimer = setTimeout(() => killGroup(pgid, "SIGKILL"), KILL_GRACE_MS);
    graceTimer.unref?.();
  };
  const onAbort = () => kill("cancel");
  o.signal.addEventListener("abort", onAbort, { once: true });
  if (o.signal.aborted) kill("cancel");
  const deadlineTimer = setTimeout(() => kill("deadline"), Math.min(MAX_TIMER, Math.max(0, o.deadline - Date.now())));

  const lines = lineReader();
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  const feed = (got: string[]) => {
    for (const l of got) {
      try {
        o.onLine(l);
      } catch {
        // a parser failure on one line never takes the run down with an unhandled exception
      }
    }
  };
  child.stdout.on("data", (b: Buffer) => {
    bytes += b.length;
    if (bytes > MAX_STDOUT) return kill("output");
    try {
      feed(lines.push(decoder.write(b)));
    } catch {
      kill("output"); // a line beyond MAX_LINE
    }
  });
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString("utf8")).slice(-MAX_STDERR);
  });

  const done = new Promise<Awaited<Spawned["done"]>>((resolve) => {
    let spawnError: string | undefined;
    child.on("error", (e) => {
      spawnError = scrub(e.message, 300);
    });
    child.on("exit", () => {
      exited = true;
      // Whatever the CLI left running in its group goes with it.
      if (pgid) killGroup(pgid, "SIGKILL");
    });
    child.on("close", (code, sig) => {
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      o.signal.removeEventListener("abort", onAbort);
      if (pgid) s.live.delete(pgid);
      try {
        feed(lines.push(decoder.end()));
        feed(lines.end());
      } catch {
        // the trailing partial line was too long; the outcome is already decided by the kill
      }
      resolve({ code, signal: sig, killed, stderr: scrub(stderr, MAX_STDERR), spawnError });
    });
  });
  return { pid: pgid, kill, done };
}

// ---------------------------------------------------------------------------------------------------------------------
// One run, shared by the Claude Code and Gemini adapters

export interface CliSpec<S> {
  prefix: string; // the run directory's name prefix
  available(): Promise<RuntimeAvailability>;
  // Writes the config into the run directory and returns the command line and environment.
  prepare(dir: RunDir, input: { prompt: string; mcpUrl: string; token: string; model?: string; budgetUsd?: number }): Promise<{ args: string[]; env: Record<string, string> }>;
  newState(): S;
  step(s: S, e: Record<string, unknown>, at: number): RuntimeEvent[];
  fatal(s: S): boolean;
  outcome(s: S, exit: { code: number | null; stderr?: string }): Pick<RuntimeResult, "state" | "text" | "error" | "errorKind" | "usage">;
  tools(s: S): string[] | undefined;
}

const fail = (errorKind: RuntimeErrorKind, error: string, extra: Partial<RuntimeResult> = {}): RuntimeResult => ({ state: "failed", errorKind, error: scrub(error, 500), ...extra });

export async function runCli<S>(o: RuntimeRunOptions, spec: CliSpec<S>): Promise<RuntimeResult> {
  const emit = (e: RuntimeEvent) => {
    try {
      o.onEvent(e);
    } catch {
      // listeners never break a run
    }
  };
  const deadline = absoluteDeadline(o.deadlineMs);
  // Bad input never reaches a process.
  let input: { prompt: string; mcpUrl: string; token: string; model?: string; budgetUsd?: number };
  try {
    if (!isRunToken(o.token)) throw new Error("the run token is missing or malformed");
    input = { prompt: promptArg(o.prompt), mcpUrl: checkMcpUrl(o.mcpUrl), token: o.token, model: o.model, budgetUsd: o.budgetUsd };
  } catch (e) {
    return fail("runtime", (e as Error).message);
  }
  if (o.signal.aborted) return { state: "cancelled" };
  if (deadline <= Date.now()) return fail("deadline", "the run's deadline passed before the CLI started");

  const avail = await spec.available();
  if (!avail.ok || !avail.path) return fail("unavailable", avail.why ?? "the runtime isn't available");

  let release: () => void;
  try {
    release = await runtimeSlots().acquire({ signal: o.signal, until: deadline, onQueued: (ahead) => emit({ type: "queued", at: Date.now(), ahead }) });
  } catch (e) {
    if (e instanceof SlotWaitError && e.reason === "cancelled") return { state: "cancelled" };
    return fail("deadline", (e as Error).message);
  }

  let dir: RunDir | undefined;
  try {
    dir = await makeRunDir(spec.prefix);
    let cmd: { args: string[]; env: Record<string, string> };
    try {
      cmd = await spec.prepare(dir, input);
    } catch (e) {
      return fail("runtime", (e as Error).message, { version: avail.version });
    }
    const state = spec.newState();
    // onLine runs on stdout data events, never during the spawnRuntime() call itself, so `proc` is set by then.
    const proc: Spawned = spawnRuntime({
      bin: avail.path,
      args: cmd.args,
      cwd: dir.work,
      env: cmd.env,
      deadline,
      signal: o.signal,
      onLine(line) {
        const e = parseLine(line);
        if (!e) return;
        for (const ev of spec.step(state, e, Date.now())) emit(ev);
        if (spec.fatal(state)) proc.kill("fatal");
      },
    });
    emit({ type: "started", at: Date.now(), pid: proc.pid, version: avail.version });
    const res = await proc.done;
    const meta = { version: avail.version, tools: spec.tools(state) };
    // A binary that can't be started (removed since available() looked, not executable): 'error', then 'close'.
    if (res.spawnError && !res.killed) return fail("unavailable", `couldn't start the CLI: ${res.spawnError}`, meta);
    if (res.killed === "cancel") return { state: "cancelled", ...meta, usage: spec.outcome(state, res).usage };
    if (res.killed === "deadline") return fail("deadline", "the run's wall-time limit was reached; the CLI was stopped", meta);
    if (res.killed === "output") return fail("runtime", `the CLI's output broke the limits (a line over 4 MB or more than ${MAX_STDOUT >> 20} MB in all); it was stopped`, meta);
    return { ...spec.outcome(state, { code: res.code, stderr: res.stderr }), ...meta };
  } finally {
    release();
    await dir?.remove();
  }
}
