#!/usr/bin/env node
// Reference agent for the Deployment Console: a terminal chat that drives the console through its operations API.
// Zero dependencies (Node 24: fetch, readline, streams). Not part of the console's runtime — copy it, change it.
//
//   CONSOLE_URL=http://localhost:3200 CONSOLE_TOKEN=dc_… ANTHROPIC_API_KEY=… node examples/agent/agent.mjs
//
// How it works: the tools come from GET /api/ops?format=anthropic (only what this token may call); every tool call is
// POST /api/ops/<name>. When a change comes back 202 (it needs a person), the plan is printed and the agent waits —
// listening on /api/events, with polling as a fallback — until someone approves or rejects it in the console, then
// hands the outcome back to the model. The token's mode decides what needs approval; this script never decides.
import { createInterface } from "node:readline/promises";
import { env, exit, stdin, stdout } from "node:process";

const CONSOLE_URL = (env.CONSOLE_URL || "http://localhost:3200").replace(/\/+$/, "");
const CONSOLE_TOKEN = env.CONSOLE_TOKEN;
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
const MODEL = env.AGENT_MODEL || "claude-sonnet-5";
const ANTHROPIC_BASE_URL = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const APPROVAL_WAIT_MS = (Number(env.AGENT_APPROVAL_WAIT_MIN) || 30) * 60_000;
const MAX_TOOL_RESULT = 100_000; // characters handed back to the model per tool call
const MAX_STEPS = 25; // model calls per user message

if (!CONSOLE_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Set CONSOLE_TOKEN (an API token from Automation → API tokens) and ANTHROPIC_API_KEY. CONSOLE_URL defaults to http://localhost:3200.");
  exit(1);
}

const tty = stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const bold = paint("1");
const yellow = paint("33");
const green = paint("32");
const red = paint("31");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the console ----------

async function api(path, init = {}) {
  const res = await fetch(CONSOLE_URL + path, {
    ...init,
    headers: { Authorization: `Bearer ${CONSOLE_TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

// Approval events from the live stream (Server-Sent Events over fetch), reconnecting until aborted.
async function listen(signal, onApproval) {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${CONSOLE_URL}/api/events`, { headers: { Authorization: `Bearer ${CONSOLE_TOKEN}`, Accept: "text/event-stream" }, signal });
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "approval" && data) onApproval(JSON.parse(data));
        }
      }
    } catch {
      if (signal.aborted) return;
      await sleep(5_000);
    }
  }
}

function printPlan(approval) {
  const p = approval.plan ?? {};
  console.log(`\n${yellow("⏸  Needs approval:")} ${bold(p.summary ?? approval.title)}`);
  for (const c of p.changes ?? []) console.log(`   • ${c}`);
  for (const w of p.warnings ?? []) console.log(yellow(`   ! ${w}`));
  if (p.estimate) console.log(`   ≈ $${p.estimate.monthlyUsd}/month (${p.estimate.note})`);
  console.log(dim(`   Approve or reject it in the console: ${CONSOLE_URL}/automation  (request ${approval.id})`));
}

// Wait until a person decides. The stream wakes us early; polling covers a dropped connection.
async function waitForDecision(approval) {
  printPlan(approval);
  const stop = new AbortController();
  let wake = () => {};
  void listen(stop.signal, (e) => e.id === approval.id && wake());
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      const { status, body } = await api(`/api/approvals/${approval.id}`);
      const a = body?.approval;
      if (status === 200 && a && a.status !== "pending" && a.status !== "approved") return decided(a);
      await new Promise((r) => {
        const t = setTimeout(r, 15_000);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
    console.log(yellow("   Still waiting — giving the model control back. The request stays open for 24 hours."));
    return { content: JSON.stringify({ approval: approval.id, status: "pending", note: "No decision yet. Do not resend; check it later with approvals_get." }) };
  } finally {
    stop.abort();
  }
}

function decided(a) {
  if (a.status === "done") {
    console.log(green(`   ✓ Approved by ${a.decidedBy} and run.`));
    return { content: JSON.stringify({ approved: true, by: a.decidedBy, result: a.result }) };
  }
  if (a.status === "failed") {
    console.log(red(`   ✗ Approved by ${a.decidedBy}, but it failed: ${a.detail}`));
    return { isError: true, content: JSON.stringify({ approved: true, by: a.decidedBy, error: a.detail }) };
  }
  if (a.status === "rejected") {
    console.log(red(`   ✗ Rejected by ${a.decidedBy}${a.detail ? `: ${a.detail}` : ""}`));
    return { isError: true, content: JSON.stringify({ rejected: true, by: a.decidedBy, reason: a.detail }) };
  }
  console.log(red(`   ✗ ${a.status}`));
  return { isError: true, content: JSON.stringify({ status: a.status }) };
}

async function runTool(name, input) {
  console.log(dim(`  → ${name} ${JSON.stringify(input)}`));
  const { status, body } = await api(`/api/ops/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ input }) });
  if (status === 202 && body?.approval) return waitForDecision(body.approval);
  const text = JSON.stringify(status >= 400 ? { status, ...body } : body?.result ?? null);
  const content = text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}… (truncated)` : text;
  if (status >= 400) console.log(dim(`    ${status}: ${body?.error ?? ""}`));
  return { content, isError: status >= 400 };
}

// ---------- the model ----------

const SYSTEM = [
  "You are an operations assistant for a Deployment Console that manages services on Amazon ECS. Use the tools to answer and act; never guess ids, environment names or revisions — look them up.",
  "Check status before changing anything, and say briefly what you are about to do. Prefer the smallest change that solves the problem.",
  'Change tools take `confirm`: "yes" on non-protected environments. On protected (production-like) environments changes go to a person for approval, who types the confirmation; still give a clear `reason`.',
  "When a tool result says a request needs approval or was rejected, report that plainly; do not send the same request again. Keep answers short: the person reads them on screen.",
].join("\n");

async function claude(messages, tools) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, system: SYSTEM, tools, messages }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const retry = res.status === 429 || res.status >= 500;
    if (!retry || attempt >= 2) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
    await sleep((Number(res.headers.get("retry-after")) || 2 ** attempt * 2) * 1000);
  }
}

// ---------- chat ----------

const [me, catalog] = await Promise.all([api("/api/me"), api("/api/ops?format=anthropic")]);
if (catalog.status !== 200) {
  console.error(`Couldn't load tools from ${CONSOLE_URL}: HTTP ${catalog.status} ${catalog.body?.error ?? ""}`);
  exit(1);
}
const tools = catalog.body.tools;
const who = me.body?.token ? `${me.body.email} via token "${me.body.token.name}" (${me.body.user.role}, ${me.body.token.mode} mode)` : me.body?.email;
console.log(`${bold("Deployment Console agent")} · ${CONSOLE_URL} · ${who}\n${dim(`${tools.length} tools · model ${MODEL} · type /exit to quit`)}`);

const rl = createInterface({ input: stdin, output: stdout });
rl.on("SIGINT", () => {
  rl.close();
  exit(0);
});
const messages = [];

for (;;) {
  let question;
  try {
    question = (await rl.question(`\n${bold("you ›")} `)).trim();
  } catch {
    break; // input closed
  }
  if (!question) continue;
  if (question === "/exit" || question === "/quit") break;
  const mark = messages.length;
  messages.push({ role: "user", content: question });
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await claude(messages, tools);
      messages.push({ role: "assistant", content: res.content }); // the whole content, thinking blocks included
      for (const b of res.content) if (b.type === "text" && b.text.trim()) console.log(`\n${bold("agent ›")} ${b.text.trim()}`);
      if (res.stop_reason === "refusal") console.log(yellow("(the model declined this request)"));
      if (res.stop_reason === "max_tokens") console.log(yellow("(the answer was cut off at max_tokens)"));
      if (res.stop_reason !== "tool_use") break;
      // Every tool result of one turn goes back in a single message.
      const results = [];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue;
        const r = await runTool(b.name, b.input);
        results.push({ type: "tool_result", tool_use_id: b.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error(red(`\n${e.message}`));
    messages.length = mark; // drop the half-finished turn so the conversation stays valid
  }
}
rl.close();
