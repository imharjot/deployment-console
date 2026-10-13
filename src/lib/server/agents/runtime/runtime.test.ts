// The local runtime adapters end to end, with fake `claude` and `gemini` binaries standing in for the real CLIs: what
// the process is started with (argv, working directory, environment, the 0600 config file), the tool allowlist, cancel
// and deadline killing the whole process group, the run directory always deleted, one CLI at a time, and the outcome
// mapping. The adapters import "server-only", which resolves only under the react-server condition, so the scenarios
// run in a child process. The real CLI is exercised by claude-smoke.test.ts (opt-in) and by c-agent-e2e.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeArgs, claudeMcpConfig } from "../../../agents/runtime/claude-args.ts";
import { geminiArgs, geminiSettings } from "../../../agents/runtime/gemini-args.ts";

const TOKEN = `da_${"T".repeat(43)}`;
const MCP_URL = "http://127.0.0.1:9/api/mcp";
const SUCCESS = readFileSync(new URL("../../../agents/runtime/fixtures/claude-success.jsonl", import.meta.url), "utf8");
const AUTH = readFileSync(new URL("../../../agents/runtime/fixtures/claude-auth-401.jsonl", import.meta.url), "utf8");
const GEMINI_OK = readFileSync(new URL("../../../agents/runtime/fixtures/gemini-success.jsonl", import.meta.url), "utf8");

// A stand-in CLI. The scenario and the report file come in the prompt ("SCENARIO:x REPORT:/path"), because the
// adapter gives the process no environment to carry them.
const fake = (o: { version: string; help?: string; stream: Record<string, string> }) => `#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log(${JSON.stringify(o.version)}); process.exit(0); }
if (argv[0] === "--help") { console.log(${JSON.stringify(o.help ?? "")}); process.exit(0); }
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const scenario = /SCENARIO:(\\S+)/.exec(prompt)?.[1];
const report = /REPORT:(\\S+)/.exec(prompt)?.[1];
const cfgAt = argv.indexOf("--mcp-config");
const cfgFile = cfgAt >= 0 ? argv[cfgAt + 1] : path.join(process.cwd(), ".gemini", "settings.json");
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const r = {
  argv, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), env: process.env, pid: process.pid, startedAt: Date.now(),
  config: JSON.parse(readFileSync(cfgFile, "utf8")), configFile: cfgFile, configMode: mode(cfgFile), rootMode: mode(path.dirname(cfgAt >= 0 ? cfgFile : process.cwd())),
};
const save = () => report && writeFileSync(report, JSON.stringify(r));
save();
const STREAM = ${JSON.stringify(o.stream)};
const out = (s) => process.stdout.write(s);
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
if (scenario === "hang" || scenario === "extra") {
  out(STREAM[scenario] ?? "");
  const kid = spawn("sleep", ["60"], { stdio: "ignore" });
  r.grandchild = kid.pid; save();
  setInterval(() => {}, 1000);
} else if (scenario === "slow") {
  await wait(700); out(STREAM.success); r.finishedAt = Date.now(); save(); process.exit(0);
} else if (scenario === "noresult") {
  process.stderr.write("panic: Bearer ${TOKEN}\\n"); process.exit(3);
} else if (scenario === "auth") {
  out(STREAM.auth); process.exit(1);
} else {
  out(STREAM.success); r.finishedAt = Date.now(); save(); process.exit(0);
}
`;

const EXTRA_INIT = `${JSON.stringify({ type: "system", subtype: "init", tools: ["Bash", "mcp__deployment-console__envs_list"], mcp_servers: [{ name: "deployment-console", status: "connected" }] })}\n`;
const HANG_INIT = `${SUCCESS.split("\n")[0]}\n`;
const GEMINI_HELP = '--output-format [choices: "text", "json", "stream-json"]\n--approval-mode\n--allowed-mcp-server-names\n-e, --extensions';

interface Run {
  r: { state: string; text?: string; error?: string; errorKind?: string; version?: string; tools?: string[]; usage?: Record<string, number> };
  events: { type: string; ahead?: number }[];
  ms: number;
  report?: Record<string, unknown> & { argv: string[]; env: Record<string, string>; config: unknown; grandchild?: number; pid: number; startedAt: number; finishedAt?: number };
  alive?: { pid: boolean; grandchild: boolean };
  dirGone?: boolean;
}
interface Out {
  avail: Record<string, { ok: boolean; version?: string; path?: string; why?: string }>;
  runs: Record<string, Run>;
  registry: Record<string, unknown>;
}

const dir = mkdtempSync(path.join(tmpdir(), "runtime-test-"));
const bins = {
  claude: path.join(dir, "claude"),
  claudeOld: path.join(dir, "claude-old"),
  gemini: path.join(dir, "gemini"),
  geminiOld: path.join(dir, "gemini-old"),
};
writeFileSync(bins.claude, fake({ version: "2.1.263 (Claude Code)", stream: { success: SUCCESS, auth: AUTH, extra: EXTRA_INIT, hang: HANG_INIT } }));
writeFileSync(bins.claudeOld, fake({ version: "2.0.14 (Claude Code)", stream: {} }));
writeFileSync(bins.gemini, fake({ version: "0.12.0", help: GEMINI_HELP, stream: { success: GEMINI_OK } }));
writeFileSync(bins.geminiOld, fake({ version: "0.1.5", help: "Options:\n  -p, --prompt\n  -y, --yolo", stream: {} }));
for (const b of Object.values(bins)) chmodSync(b, 0o755);

const scenario = `
import { existsSync } from "node:fs";
import path from "node:path";
const reg = await import(${JSON.stringify(new URL("./registry.ts", import.meta.url).href)});
const proc = await import(${JSON.stringify(new URL("./process.ts", import.meta.url).href)});
const { runStateForRuntimeError } = await import(${JSON.stringify(new URL("../../../agents/runtime/types.ts", import.meta.url).href)});
const fs = await import("node:fs");
const DIR = ${JSON.stringify(dir)};
const TOKEN = ${JSON.stringify(TOKEN)};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readReport = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };
let n = 0;
async function run(kind, scenario, o = {}) {
  const report = path.join(DIR, "report-" + (++n) + ".json");
  const events = [];
  const ac = new AbortController();
  const t0 = Date.now();
  const p = reg.runtimeFor(kind).run({ prompt: "List the environments SCENARIO:" + scenario + " REPORT:" + report, mcpUrl: ${JSON.stringify(MCP_URL)}, token: o.token ?? TOKEN,
    deadlineMs: o.deadlineMs ?? 20000, signal: ac.signal, model: o.model, budgetUsd: o.budgetUsd, onEvent: (e) => { events.push(e); if (o.throwing) throw new Error("listener"); } });
  if (o.cancelAfterGrandchild) {
    for (let i = 0; i < 100 && !readReport(report)?.grandchild; i++) await sleep(50);
    ac.abort();
  }
  const r = await p;
  const ms = Date.now() - t0;
  const rep = readReport(report);
  await sleep(300);
  const out = { r, events, ms, report: rep };
  if (rep) {
    out.alive = { pid: alive(rep.pid), grandchild: rep.grandchild ? alive(rep.grandchild) : false };
    out.dirGone = !existsSync(path.dirname(rep.configFile)) && !existsSync(rep.cwd);
  }
  return out;
}
const avail = {};
avail.claude = await reg.runtimeFor("claude-code").available();
process.env.CONSOLE_CLAUDE_BIN = ${JSON.stringify(bins.claudeOld)};
avail.claudeOld = await reg.runtimeFor("claude-code").available();
process.env.CONSOLE_CLAUDE_BIN = "claude-relative";
avail.claudeRelative = await reg.runtimeFor("claude-code").available();
process.env.CONSOLE_CLAUDE_BIN = path.join(DIR, "missing");
avail.claudeMissing = await reg.runtimeFor("claude-code").available();
process.env.CONSOLE_CLAUDE_BIN = ${JSON.stringify(bins.claude)};
avail.gemini = await reg.runtimeFor("gemini-cli").available();
process.env.CONSOLE_GEMINI_BIN = ${JSON.stringify(bins.geminiOld)};
avail.geminiOld = await reg.runtimeFor("gemini-cli").available();

const runs = {};
runs.success = await run("claude-code", "success", { model: "sonnet", budgetUsd: 3, throwing: true });
runs.extra = await run("claude-code", "extra");
runs.cancel = await run("claude-code", "hang", { cancelAfterGrandchild: true });
runs.deadline = await run("claude-code", "hang", { deadlineMs: 1500 });
runs.auth = await run("claude-code", "auth");
runs.auth.pause = runStateForRuntimeError(runs.auth.r.errorKind);
runs.noresult = await run("claude-code", "noresult");
runs.badToken = await run("claude-code", "success", { token: "dc_nope" });
const [a, b] = await Promise.all([run("claude-code", "slow"), run("claude-code", "slow")]);
runs.slowA = a; runs.slowB = b;
// A binary removed after available() looked: the spawn fails and the run says so.
const vanish = path.join(DIR, "claude-vanish");
fs.copyFileSync(${JSON.stringify(bins.claude)}, vanish);
fs.chmodSync(vanish, 0o755);
process.env.CONSOLE_CLAUDE_BIN = vanish;
await reg.runtimeFor("claude-code").available();
fs.rmSync(vanish);
runs.vanished = await run("claude-code", "success");
process.env.CONSOLE_CLAUDE_BIN = ${JSON.stringify(bins.claude)};
runs.geminiOld = await run("gemini-cli", "success");
process.env.CONSOLE_GEMINI_BIN = ${JSON.stringify(bins.gemini)};
runs.gemini = await run("gemini-cli", "success", { model: "gemini-2.5-pro" });
const registry = {
  byProvider: reg.runtimeForProvider("runtime:claude-code")?.kind, gemini: reg.runtimeForProvider("runtime:gemini-cli")?.kind, api: reg.runtimeForProvider("anthropic") ?? null,
  bogus: (() => { try { reg.runtimeFor("bogus"); return "no error"; } catch (e) { return e.message; } })(),
  mcpUrl: reg.consoleMcpUrl(), slotsActive: proc.runtimeSlots().active(),
  status: await reg.runtimeStatus(),
};
console.log(JSON.stringify({ avail, runs, registry }));
`;

const env: NodeJS.ProcessEnv = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: process.env.HOME ?? dir,
  USER: process.env.USER ?? "test",
  LANG: "en_US.UTF-8",
  CONSOLE_CLAUDE_BIN: bins.claude,
  CONSOLE_GEMINI_BIN: bins.gemini,
  CONSOLE_SOURCE: "mock",
  CONSOLE_SQLITE_PATH: ":memory:",
  CONSOLE_DATA_DIR: dir,
  PORT: "3277",
  NODE_ENV: "test",
  // Sentinels: none of these may reach a runtime.
  AWS_ACCESS_KEY_ID: "AKIASENTINEL12345678",
  AWS_SECRET_ACCESS_KEY: "sentinel-aws",
  CONSOLE_SECRET_KEY: "sentinel-console",
  ANTHROPIC_API_KEY: "sentinel-anthropic",
  OPENAI_API_KEY: "sentinel-openai",
  GITHUB_TOKEN: "sentinel-github",
  GEMINI_API_KEY: "sentinel-gemini",
  DATABASE_URL: "postgres://sentinel:sentinel@127.0.0.1/db",
};
const stdout = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
  encoding: "utf8",
  env,
  timeout: 120_000,
  maxBuffer: 32 << 20,
});
const o = JSON.parse(stdout.trim().split("\n").pop()!) as Out;

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("available(): the binary from CONSOLE_CLAUDE_BIN and its version; too old, relative or missing → the reason", () => {
  assert.deepEqual(o.avail.claude, { ok: true, version: "2.1.263", path: bins.claude });
  assert.equal(o.avail.claudeOld.ok, false);
  assert.match(o.avail.claudeOld.why!, /Claude Code 2\.0\.14 is older than 2\.1\.263/);
  assert.match(o.avail.claudeRelative.why!, /must be an absolute path/);
  assert.match(o.avail.claudeMissing.why!, /is not an executable file/);
  assert.deepEqual(o.avail.gemini, { ok: true, version: "0.12.0", path: bins.gemini });
  assert.match(o.avail.geminiOld.why!, /Gemini CLI 0\.1\.5 is too old for HTTP MCP/);
});

test("a run starts the CLI with exactly the restricted argv, an empty working directory, a 0600 config and a minimal environment", () => {
  const { r, report, events, dirGone } = o.runs.success;
  assert.equal(r.state, "completed", r.error);
  assert.match(r.text!, /staging is DEGRADED/);
  assert.equal(r.version, "2.1.263");
  assert.deepEqual(r.tools, ["mcp__deployment-console__envs_list", "mcp__deployment-console__envs_status"]);
  const rep = report!;
  const cfg = String(rep.configFile);
  assert.deepEqual(rep.argv, claudeArgs({ prompt: rep.argv[1], mcpConfigFile: cfg, model: "sonnet", budgetUsd: 3 }));
  assert.match(rep.argv[1], /^List the environments SCENARIO:success/);
  assert.deepEqual(rep.config, claudeMcpConfig(MCP_URL, TOKEN));
  assert.equal(rep.configMode, "600");
  assert.equal(rep.rootMode, "700");
  assert.deepEqual(rep.cwdEntries, [], "the working directory is empty");
  assert.equal(path.dirname(String(rep.cwd)), path.dirname(cfg));
  assert.deepEqual(Object.keys(rep.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort(), ["DISABLE_AUTOUPDATER", "HOME", "LANG", "PATH", "TERM", "TMPDIR", "USER"]);
  assert.ok(!JSON.stringify(rep.env).includes("sentinel"), "no server secret reaches the CLI");
  assert.ok(String(rep.env.TMPDIR).startsWith(path.dirname(cfg)));
  assert.equal(dirGone, true, "the run directory (and the token file) is deleted");
  assert.deepEqual(events.map((e) => e.type), ["started", "init", "text", "tool_use", "tool_result", "tool_use", "tool_result", "text", "usage"]);
});

test("unexpected tools: the process group is killed at the init event and the run fails", () => {
  const { r, ms, alive, dirGone } = o.runs.extra;
  assert.deepEqual([r.state, r.errorKind, r.error], ["failed", "tools", "runtime exposed unexpected tools: Bash"]);
  assert.ok(ms < 8000, `took ${ms} ms`);
  assert.deepEqual(alive, { pid: false, grandchild: false });
  assert.equal(dirGone, true);
});

test("cancel and the deadline kill the whole process group; the directory still goes", () => {
  const c = o.runs.cancel;
  assert.equal(c.r.state, "cancelled");
  assert.ok(c.report?.grandchild, "the fake started a grandchild");
  assert.deepEqual(c.alive, { pid: false, grandchild: false });
  assert.equal(c.dirGone, true);
  const d = o.runs.deadline;
  assert.deepEqual([d.r.state, d.r.errorKind], ["failed", "deadline"]);
  assert.ok(d.ms >= 1400 && d.ms < 8000, `took ${d.ms} ms`);
  assert.deepEqual(d.alive, { pid: false, grandchild: false });
  assert.equal(d.dirGone, true);
});

test("outcomes: a refused login pauses for auth; a crash is a scrubbed runtime failure; a bad token never starts a process", () => {
  const a = o.runs.auth as Run & { pause: string };
  assert.deepEqual([a.r.state, a.r.errorKind, a.pause], ["failed", "auth", "paused_auth"]);
  const n = o.runs.noresult;
  assert.equal(n.r.errorKind, "runtime");
  assert.match(n.r.error!, /exited with code 3 without a result/);
  assert.ok(!n.r.error!.includes(TOKEN.slice(3, 20)), "the token printed on stderr is scrubbed");
  const b = o.runs.badToken;
  assert.deepEqual([b.r.state, b.r.errorKind, b.report], ["failed", "runtime", undefined]);
});

test("a binary that disappeared after the availability check: unavailable, not a crash", () => {
  const v = o.runs.vanished;
  assert.deepEqual([v.r.state, v.r.errorKind], ["failed", "unavailable"]);
  assert.match(v.r.error!, /couldn't start the CLI/);
});

test("one CLI at a time: the second run waits in the queue and starts after the first finished", () => {
  const { slowA, slowB } = o.runs;
  assert.equal(slowA.r.state, "completed");
  assert.equal(slowB.r.state, "completed");
  const [first, second] = slowA.report!.startedAt < slowB.report!.startedAt ? [slowA, slowB] : [slowB, slowA];
  assert.ok(second.report!.startedAt >= first.report!.finishedAt!, "no overlap");
  assert.deepEqual(second.events.find((e) => e.type === "queued")?.ahead, 1);
  assert.equal(o.registry.slotsActive, 0);
});

test("Gemini: too old → unavailable; a current CLI gets its workspace settings (0600) and the restricted flags", () => {
  assert.deepEqual([o.runs.geminiOld.r.state, o.runs.geminiOld.r.errorKind], ["failed", "unavailable"]);
  assert.match(o.runs.geminiOld.r.error!, /too old for HTTP MCP/);
  const g = o.runs.gemini;
  assert.equal(g.r.state, "completed", g.r.error);
  assert.equal(g.r.text, "Staging is DEGRADED.");
  const rep = g.report!;
  assert.deepEqual(rep.argv, geminiArgs({ prompt: rep.argv[1], model: "gemini-2.5-pro" }));
  assert.deepEqual(rep.config, geminiSettings(MCP_URL, TOKEN));
  assert.equal(rep.configMode, "600");
  assert.deepEqual(rep.cwdEntries, [".gemini"]);
  assert.equal(rep.env.GEMINI_CLI_TRUST_WORKSPACE, "true");
  assert.ok(!JSON.stringify(rep.env).includes("sentinel"));
  assert.equal(g.dirGone, true);
});

test("registry: runtimeFor / runtimeForProvider, the MCP URL on the loopback port", () => {
  assert.equal(o.registry.byProvider, "claude-code");
  assert.equal(o.registry.gemini, "gemini-cli");
  assert.equal(o.registry.api, null);
  assert.match(String(o.registry.bogus), /unknown runtime/);
  assert.equal(o.registry.mcpUrl, "http://127.0.0.1:3277/api/mcp");
  const status = o.registry.status as Record<string, { ok: boolean }>;
  assert.deepEqual(Object.keys(status).sort(), ["claude-code", "gemini-cli"]);
});
