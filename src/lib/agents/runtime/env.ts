// What both local runtimes share: the minimal environment a CLI is started with, the prompt as one argv element, the
// run token's shape, and scrubbing of anything the CLI prints before it reaches a diagnostic. Pure.

// The CLI gets only what it needs to find itself and the person's login: PATH, HOME (the subscription login lives under
// it and in the user's keychain), USER, LANG, TERM, and CLAUDE_CONFIG_DIR when the server has one. Nothing else from
// the server's environment — in particular no AWS_*, CONSOLE_*, ANTHROPIC_*, OPENAI_*, GITHUB_* or DATABASE_URL — so
// the CLI can't reach the console's AWS identity, database, secret key or an API key that would bill someone else.
export const PASSED_ENV = ["PATH", "HOME", "USER", "LANG", "TERM"] as const;
export const OPTIONAL_ENV = ["CLAUDE_CONFIG_DIR"] as const;
// A runtime adapter's own additions (GEMINI_CLI_TRUST_WORKSPACE, NO_COLOR) are checked against this too, so a slip in
// an adapter can't hand the CLI a credential: the server's prefixes, and anything named like a key, token or password.
export const NEVER_PASSED =
  /^(?:AWS_|CONSOLE_|ANTHROPIC_|OPENAI_|GITHUB_|GOOGLE_|DATABASE_URL$|PG[A-Z]|OIDC_|CLOUDFLARE_|NODE_OPTIONS$)|(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i;

export function runtimeEnv(src: Record<string, string | undefined>, o: { tmpDir?: string; extra?: Record<string, string> } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSED_ENV) {
    const v = src[k];
    if (typeof v === "string" && v) env[k] = v;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  env.LANG ??= "en_US.UTF-8";
  env.TERM = "dumb"; // no TTY: plain output, no colours or cursor control
  for (const k of OPTIONAL_ENV) {
    const v = src[k];
    if (typeof v === "string" && v) env[k] = v;
  }
  // A scratch directory of the run's own (deleted with it), so nothing the CLI writes to $TMPDIR outlives the run.
  if (o.tmpDir) env.TMPDIR = o.tmpDir;
  // The server must not update the person's binary under them mid-run.
  env.DISABLE_AUTOUPDATER = "1";
  for (const [k, v] of Object.entries(o.extra ?? {})) if (!NEVER_PASSED.test(k)) env[k] = v;
  return env;
}

// The run-scoped token the CLI presents to /api/mcp: "da_" + 43 base64url characters (agent-tokens.ts). Checked before
// it is written into a config file, so a malformed value can never inject another header or JSON field.
export const RUN_TOKEN = /^da_[A-Za-z0-9_-]{43}$/;
export const isRunToken = (t: unknown): t is string => typeof t === "string" && RUN_TOKEN.test(t);

// The MCP URL the CLI calls: http(s), no credentials in it, a path — the console's own /api/mcp in practice.
export function checkMcpUrl(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error("the MCP URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the MCP URL must be http(s)");
  if (url.username || url.password) throw new Error("the MCP URL must not carry credentials");
  if (url.hash) throw new Error("the MCP URL must not have a fragment");
  return url.toString();
}

// Where a local CLI reaches the console's MCP endpoint: CONSOLE_PUBLIC_URL when set, else the loopback address of the
// port this server listens on (Next sets PORT; 3200 by default). The CLI runs on the console's own machine.
export function consoleMcpUrl(env: Record<string, string | undefined>): string {
  const pub = env.CONSOLE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (pub) return checkMcpUrl(`${pub}/api/mcp`);
  const port = Number.parseInt(env.PORT ?? "", 10);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 3200}/api/mcp`;
}

// The prompt goes in argv right after -p. An element starting with "-" would be parsed as an option (a goal of
// "--dangerously-skip-permissions" must stay text), so such a prompt is prefixed; NUL bytes can't be passed in argv.
export const MAX_PROMPT = 100_000;
export function promptArg(prompt: string): string {
  if (typeof prompt !== "string") throw new Error("the prompt must be text");
  const p = prompt.replace(/\0/g, "").trim();
  if (!p) throw new Error("the prompt is empty");
  if (p.length > MAX_PROMPT) throw new Error(`the prompt is longer than ${MAX_PROMPT} characters`);
  return p.startsWith("-") ? `Task: ${p}` : p;
}

// A model name as the CLI takes it ("sonnet", "claude-sonnet-5", "gemini-2.5-pro", "opus[1m]").
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;

// Anything a CLI printed (stderr, an error result) before it reaches a run record, a log line or an API response:
// console and agent tokens, bearer and basic headers, JWTs, API keys and AWS access keys are replaced by a label.
export function scrub(text: string, max = 2_000): string {
  const s = String(text ?? "")
    .replace(/\b(?:da|dc)_[A-Za-z0-9_-]{16,}/g, "[token]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[api-key]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[aws-key]")
    .replace(/("?(?:access_token|refresh_token|id_token|api[_-]?key|authorization|password|secret)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi, "$1[redacted]")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
