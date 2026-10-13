// Redaction, minimisation and the untrusted-evidence wrapper for everything an agent reads or the console keeps about a
// run: tool results, logs, adapter errors, transcripts, diagnostics. Pure (no Node or DOM APIs beyond TextEncoder), so
// the server (runner, run store, credential broker) and the browser (the assistant composer refuses text that looks
// like a secret) share one set of rules.
//
// Regex redaction is a backstop, not proof that a text is safe to send to a model provider (AGENT_ARCHITECTURE §6):
// the defaults that matter stay elsewhere — logs reach a model bounded and redacted, and secret values are never
// fetched for one. Findings are labels only, never the values (or any part of them).
//
//   redact(text)            → { text, findings }       one string
//   redactDeep(value)       → { value, findings }      JSON-like values: strings, object keys and secret-named fields
//   minimise(value, budget) → { value, cut, bytes }    caps strings, lines, arrays, keys, depth and total size; `cut` says what went
//   untrusted(source, observedAt, data)                 the evidence envelope the model is told never to obey
//   prepareEvidence(source, observedAt, data, budget?)  all three, in the safe order (redact before cutting)

export type RedactionLabel =
  | "private-key"
  | "pem-block"
  | "presigned-url"
  | "url-password"
  | "webhook-url"
  | "authorization-header"
  | "cookie"
  | "bearer-token"
  | "console-token"
  | "jwt"
  | "aws-access-key-id"
  | "aws-secret-access-key"
  | "vendor-token"
  | "secret-value";

export interface Redacted {
  text: string;
  findings: RedactionLabel[]; // each kind found, once, in the order first seen
}

// What replaces a value. It names the kind so a reader (or a model) knows something was there, and no rule matches it.
export const marker = (label: RedactionLabel) => `[redacted:${label}]`;
const MARKER = /^\[redacted(?::[a-z-]+)?\]$/;

// ---------- names ----------

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

// A field or variable whose name ends in one of these holds a secret whatever its value looks like (SecretString and
// SecretBinary are what Secrets Manager calls a secret's value). Plural "tokens"
// (max_tokens, input_tokens) and names that merely start with a secret word (PASSWORD_MIN_LENGTH, TOKEN_TTL) don't.
const STRONG_NAME =
  /(password|passwd|pwd|passphrase|secret|token|apikey|accesskey|privatekey|credential|credentials|connectionstring|connstr|dsn|signingkey|encryptionkey|masterkey|webhookurl|cookie|sessionid|authorization|clientsecret|secretstring|secretbinary)$/;
// These may or may not: CACHE_KEY and PARTITION_KEY are ordinary, a 40-character random SIGNING_SIGNATURE is not.
// Only a long, high-entropy value under such a name is removed.
const WEAK_NAME = /(key|signature|auth|session|salt|nonce|hmac)$/;

export const secretName = (name: string): "strong" | "weak" | undefined => {
  const n = norm(name);
  if (!n) return undefined;
  if (STRONG_NAME.test(n)) return "strong";
  if (WEAK_NAME.test(n)) return "weak";
  return undefined;
};

// Shannon entropy in bits per character.
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Values that are clearly not a secret: empty, a placeholder, a flag, a small number, a reference to where the secret
// lives (an ARN, ${VAR}, {{resolve:…}}), or an earlier redaction marker.
const PLACEHOLDER = /^(|\*+|x+|null|nil|none|undefined|true|false|yes|no|on|off|redacted|hidden|masked|changeme-not-set|<[^>]*>|\[[^\]]*\]|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]*\}\}|%[sd]|\(hidden\)|\(set\))$/i;
const REFERENCE = /^(arn:aws[a-z-]*:(secretsmanager|ssm|kms|iam):|ssm:|secret:|vault:|op:\/\/)/i;

function secretValue(name: string, raw: string): boolean {
  const kind = secretName(name);
  if (!kind) return false;
  const v = raw.trim();
  if (MARKER.test(v) || PLACEHOLDER.test(v) || REFERENCE.test(v)) return false;
  if (/^-?\d{1,4}$/.test(v)) return false; // token: 0, pwd_len=12
  if (kind === "strong") return v.length >= 4;
  return v.length >= 16 && entropy(v) >= 3.5;
}

// ---------- text rules ----------

// One pass of a regex with a replacer; records the label when anything was replaced.
type Found = Set<RedactionLabel>;
function pass(text: string, re: RegExp, label: RedactionLabel, found: Found, replace: (m: string, ...g: string[]) => string | undefined): string {
  return text.replace(re, (m: string, ...rest: unknown[]) => {
    const groups = rest.slice(0, -2).map((g) => (typeof g === "string" ? g : ""));
    const r = replace(m, ...groups);
    if (r === undefined || r === m) return m;
    found.add(label);
    return r;
  });
}

// PEM: a BEGIN…END block; a BEGIN with no END (a log cut short) runs to the end of the text; an END with no BEGIN (the
// head was cut) takes the base64 lines right before it. Done with indexOf, not a regex, so a text full of BEGIN lines
// stays linear.
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{1,48})-----/g;
const PEM_END = /-----END ([A-Z0-9 ]{1,48})-----/g;
const isKey = (type: string) => /PRIVATE|SECRET|KEY BLOCK/.test(type);

function pem(text: string, found: Found): string {
  if (!text.includes("-----BEGIN ") && !text.includes("-----END ")) return text;
  const spans: { from: number; to: number; label: RedactionLabel }[] = [];
  const begins = [...text.matchAll(PEM_BEGIN)];
  const ends = [...text.matchAll(PEM_END)];
  let ei = 0;
  let pos = 0;
  for (const b of begins) {
    if (b.index < pos) continue;
    while (ei < ends.length && ends[ei].index < b.index) {
      // an END before this BEGIN with no BEGIN of its own: the head of the block was cut off
      spans.push(orphanEnd(text, ends[ei], pos));
      ei++;
    }
    const end = ends[ei];
    const label: RedactionLabel = isKey(b[1]) ? "private-key" : "pem-block";
    if (end) {
      spans.push({ from: b.index, to: end.index + end[0].length, label });
      pos = end.index + end[0].length;
      ei++;
    } else {
      spans.push({ from: b.index, to: text.length, label });
      pos = text.length;
    }
  }
  for (; ei < ends.length; ei++) if (ends[ei].index >= pos) spans.push(orphanEnd(text, ends[ei], pos));
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const s of spans.sort((a, b) => a.from - b.from)) {
    if (s.from < at) continue;
    out += text.slice(at, s.from) + marker(s.label);
    found.add(s.label);
    at = s.to;
  }
  return out + text.slice(at);
}

function orphanEnd(text: string, end: RegExpExecArray | RegExpMatchArray, floor: number) {
  const idx = end.index ?? 0;
  let from = idx;
  // walk back over whole lines of base64
  for (;;) {
    const lineEnd = text.lastIndexOf("\n", from - 1);
    if (lineEnd < floor) {
      const line = text.slice(floor, from).trim();
      if (/^[A-Za-z0-9+/=]{8,}$/.test(line)) from = floor;
      break;
    }
    const lineStart = text.lastIndexOf("\n", lineEnd - 1) + 1;
    const line = text.slice(Math.max(lineStart, floor), lineEnd).trim();
    if (!/^[A-Za-z0-9+/=]{8,}$/.test(line)) {
      from = lineEnd + 1;
      break;
    }
    from = Math.max(lineStart, floor);
  }
  const label: RedactionLabel = isKey(end[1] ?? "") ? "private-key" : "pem-block";
  return { from: Math.min(from, idx), to: idx + end[0].length, label };
}

// URLs: a presigned query (S3/CloudFront signatures, temporary credentials) loses its whole query string; a password in
// the authority loses the password; chat webhooks (the URL is the credential) lose their path.
const URL_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>`\\]+/gi;
const SIGNED_QUERY = /[?&](x-amz-signature|x-amz-credential|x-amz-security-token|signature|awsaccesskeyid|sig|key-pair-id|policy|sv|se)=/i;
const STRONG_SIGNED = /[?&](x-amz-signature|x-amz-credential|x-amz-security-token|signature|awsaccesskeyid|sig)=/i;
const SCHEME = /^[a-z][a-z0-9+.-]{1,20}:\/\//i;
const WEBHOOK = /^(https?:\/\/(?:hooks\.slack\.com\/services|(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks|outlook\.office\.com\/webhook|[a-z0-9-]+\.webhook\.office\.com\/webhookb2|chat\.googleapis\.com\/v1\/spaces))\/[^\s"'<>]+/i;

function urls(text: string, found: Found): string {
  return text.replace(URL_RE, (u) => {
    let out = u;
    const hook = WEBHOOK.exec(out);
    if (hook) {
      found.add("webhook-url");
      return `${hook[1]}/${marker("webhook-url")}`;
    }
    const q = out.indexOf("?");
    if (q >= 0 && STRONG_SIGNED.test(out.slice(q)) && SIGNED_QUERY.test(out.slice(q))) {
      found.add("presigned-url");
      out = `${out.slice(0, q)}?${marker("presigned-url")}`;
    }
    // user:password@host — the authority ends at the first / ? or #, and the password runs to its LAST @ (an
    // unencoded @ inside a password must not leave the rest of it behind).
    const scheme = SCHEME.exec(out)?.[0] ?? "";
    const rest = out.slice(scheme.length);
    const authEnd = rest.search(/[/?#]/);
    const authority = authEnd < 0 ? rest : rest.slice(0, authEnd);
    const at = authority.lastIndexOf("@");
    const colon = at > 0 ? authority.indexOf(":") : -1;
    if (at > 0 && colon >= 0 && colon < at) {
      const password = authority.slice(colon + 1, at);
      if (password && password !== "*" && !MARKER.test(password)) {
        found.add("url-password");
        out = `${scheme}${authority.slice(0, colon)}:${marker("url-password")}${rest.slice(at)}`;
      }
    }
    return out;
  });
}

// Header lines and header-shaped fields: the whole value goes (an Authorization value is "<scheme> <credential>").
const HEADER_RE = /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-amz-security-token|x-goog-api-key|set-cookie|cookie)(\\?["']?\s*[:=]\s*)(\\?["']?)([^\r\n"'\\]{1,8192})/gi;

function headers(text: string, found: Found): string {
  return text.replace(HEADER_RE, (m, name: string, sep: string, q: string, value: string) => {
    if (MARKER.test(value.trim()) || PLACEHOLDER.test(value.trim())) return m;
    const lower = name.toLowerCase();
    const label: RedactionLabel = lower === "cookie" || lower === "set-cookie" ? "cookie" : "authorization-header";
    found.add(label);
    return `${name}${sep}${q}${marker(label)}`;
  });
}

// Credentials with a recognisable shape, wherever they appear.
const SHAPES: [RegExp, RedactionLabel][] = [
  // dc_ / da_ + 43 base64url characters (a few more or fewer still count: a token pasted with a stray character)
  [/(?<![A-Za-z0-9])(?:dc|da)_[A-Za-z0-9_-]{32,64}(?![A-Za-z0-9_-])/g, "console-token"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "jwt"],
  [/\b(?:Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{12,}/g, "bearer-token"],
  [/(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, "aws-access-key-id"],
  [
    /(?<![A-Za-z0-9_-])(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9_-]{20,})/g,
    "vendor-token",
  ],
];

// A bare 40-character base64 string with upper, lower and a digit is what an AWS secret access key looks like. Git SHAs
// (lower-case hex) and UUIDs don't qualify.
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const awsSecretLike = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s) && !/^[0-9a-f]+$/i.test(s) && entropy(s) >= 4;

// NAME=value, NAME: value, "name": "value", --name=value, and their JSON-escaped forms inside a string. The name starts
// a word and the separator stays on its line (a YAML key on the next line is its own match). Value forms, in order: an
// earlier marker or a [placeholder], ${VAR} / {{ref}}, an escaped-quoted, double- or single-quoted string, or a bare
// run that ends at whitespace, a quote, ; , or an & that starts the next name= pair (a password may contain &).
const ASSIGN =
  /(?<![A-Za-z0-9_.])(\\?["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})(\1)([ \t]*[:=][ \t]*)(\[[^\]\r\n]{0,200}\]|\$\{[^}\r\n]{0,200}\}|\{\{[^}\r\n]{0,200}\}\}|\\"[^"\r\n]{0,4096}?\\"|"(?:[^"\\\r\n]|\\.){0,4096}"|'[^'\r\n]{0,4096}'|(?:[^\s"',;&}\])>\\]|&(?![A-Za-z_][A-Za-z0-9_.-]{0,80}=)){1,4096})/g;

function assignments(text: string, found: Found): string {
  return text.replace(ASSIGN, (m, q1: string, name: string, q2: string, sep: string, value: string) => {
    const quote = value.startsWith('\\"') ? '\\"' : value[0] === '"' || value[0] === "'" ? value[0] : "";
    const inner = quote ? value.slice(quote.length, value.length - quote.length) : value;
    if (!secretValue(name, inner)) return m;
    found.add("secret-value");
    return `${q1}${name}${q2}${sep}${quote}${marker("secret-value")}${quote}`;
  });
}

// Name/value pairs whose name says secret, as ECS task definitions, CloudFormation parameters and most env-var APIs
// write them: {"name": "DB_PASSWORD", "value": "…"} in either order, plain JSON or JSON escaped inside a string.
const PAIR_NAME = String.raw`(?:name|Name|key|Key|ParameterKey|OptionName)`;
const PAIR_VALUE = String.raw`(?:value|Value|ParameterValue)`;
const PAIRS: RegExp[] = [
  new RegExp(String.raw`("${PAIR_NAME}"\s*:\s*")([^"\\\r\n]{1,200})("\s*,\s*"${PAIR_VALUE}"\s*:\s*")((?:[^"\\\r\n]|\\.){0,4096})(")`, "g"),
  new RegExp(String.raw`(\\"${PAIR_NAME}\\"\s*:\s*\\")([^"\\\r\n]{1,200})(\\"\s*,\s*\\"${PAIR_VALUE}\\"\s*:\s*\\")([^\r\n]{0,4096}?)(\\")(?=\s*[,}\]])`, "g"),
];
const PAIRS_REVERSED: RegExp[] = [
  new RegExp(String.raw`("${PAIR_VALUE}"\s*:\s*")((?:[^"\\\r\n]|\\.){0,4096})("\s*,\s*"${PAIR_NAME}"\s*:\s*")([^"\\\r\n]{1,200})(")`, "g"),
  new RegExp(String.raw`(\\"${PAIR_VALUE}\\"\s*:\s*\\")([^\r\n]{0,4096}?)(\\"\s*,\s*\\"${PAIR_NAME}\\"\s*:\s*\\")([^"\\\r\n]{1,200})(\\")`, "g"),
];

function pairs(text: string, found: Found): string {
  if (!/alue/.test(text)) return text;
  let t = text;
  for (const re of PAIRS)
    t = t.replace(re, (m, a: string, name: string, b: string, value: string, c: string) => {
      if (!secretValue(name, value)) return m;
      found.add("secret-value");
      return `${a}${name}${b}${marker("secret-value")}${c}`;
    });
  for (const re of PAIRS_REVERSED)
    t = t.replace(re, (m, a: string, value: string, b: string, name: string, c: string) => {
      if (!secretValue(name, value)) return m;
      found.add("secret-value");
      return `${a}${marker("secret-value")}${b}${name}${c}`;
    });
  return t;
}

// Removes every credential the rules recognise from one string. Idempotent: redacting redacted text finds nothing.
export function redact(text: string): Redacted {
  if (typeof text !== "string" || !text) return { text: typeof text === "string" ? text : "", findings: [] };
  const found: Found = new Set();
  let t = pem(text, found);
  t = urls(t, found);
  t = headers(t, found);
  for (const [re, label] of SHAPES) t = pass(t, re, label, found, () => marker(label));
  t = pass(t, AWS_SECRET, "aws-secret-access-key", found, (m) => (awsSecretLike(m) ? marker("aws-secret-access-key") : undefined));
  t = pairs(t, found);
  t = assignments(t, found);
  return { text: t, findings: order(found) };
}

const LABEL_ORDER: RedactionLabel[] = [
  "private-key", "pem-block", "presigned-url", "url-password", "webhook-url", "authorization-header", "cookie", "bearer-token",
  "console-token", "jwt", "aws-access-key-id", "aws-secret-access-key", "vendor-token", "secret-value",
];
const order = (s: Found): RedactionLabel[] => LABEL_ORDER.filter((l) => s.has(l));

// ---------- structured values ----------

// Strings are redacted; a field whose name says it holds a secret loses its value (a whole object under a strong name
// — "credentials": { … } — goes at once); keys are redacted too. Arrays and plain objects are copied, never mutated.
export function redactDeep<T = unknown>(value: T): { value: T; findings: RedactionLabel[] } {
  const found: Found = new Set();
  const seen = new WeakSet<object>();
  const walk = (v: unknown, name: string | undefined): unknown => {
    if (typeof v === "string") {
      if (name !== undefined && secretValue(name, v)) {
        found.add("secret-value");
        return marker("secret-value");
      }
      const r = redact(v);
      for (const f of r.findings) found.add(f);
      return r.text;
    }
    if (typeof v === "number" || typeof v === "bigint") {
      if (name !== undefined && secretName(name) === "strong" && secretValue(name, String(v))) {
        found.add("secret-value");
        return marker("secret-value");
      }
      return v;
    }
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (name !== undefined && secretName(name) === "strong" && !Array.isArray(v) && Object.keys(v).length) {
      found.add("secret-value");
      return marker("secret-value");
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, undefined));
    if (v instanceof Date) return v;
    const o = v as Record<string, unknown>;
    // { name: "DB_PASSWORD", value: "…" }: the value's field is called "value", its name is a sibling.
    const pairName = ["name", "Name", "key", "Key", "ParameterKey", "OptionName"].map((k) => (Object.hasOwn(o, k) && typeof o[k] === "string" ? (o[k] as string) : undefined)).find((x) => x !== undefined);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      const rk = redact(k);
      for (const f of rk.findings) found.add(f);
      if (pairName !== undefined && /^(value|Value|ParameterValue)$/.test(k) && typeof x === "string" && secretValue(pairName, x)) {
        found.add("secret-value");
        out[rk.text] = marker("secret-value");
        continue;
      }
      out[rk.text] = walk(x, k);
    }
    return out;
  };
  const value2 = walk(value, undefined) as T;
  return { value: value2, findings: order(found) };
}

// ---------- minimisation ----------

export interface Budget {
  maxBytes?: number; // the whole value as JSON (UTF-8). Default 16 KB
  maxString?: number; // characters per string. Default 4,000
  maxLines?: number; // lines per string. Default 200
  maxArray?: number; // items per array, keys per object. Default 100
  maxDepth?: number; // nesting. Default 8
  keep?: "head" | "tail"; // which end of a long list or text survives. Default head (tail suits logs: the newest lines)
}

export interface Minimised<T = unknown> {
  value: T;
  cut: string[]; // what was removed, in words ("$.events: kept the first 100 of 340 items")
  bytes: number; // the JSON size of `value`
}

export const DEFAULT_BUDGET: Required<Budget> = { maxBytes: 16_384, maxString: 4_000, maxLines: 200, maxArray: 100, maxDepth: 8, keep: "head" };

const enc = new TextEncoder();
const sizeOf = (v: unknown) => {
  try {
    return enc.encode(JSON.stringify(v) ?? "").length;
  } catch {
    return Infinity;
  }
};
const fmt = (n: number) => n.toLocaleString("en-US");
const child = (path: string, k: string | number) => (typeof k === "number" ? `${path}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

function shrink(value: unknown, b: Required<Budget>, cut: string[]): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return text(v, path);
    if (typeof v !== "object") return undefined; // functions, symbols, undefined: JSON drops them too
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (seen.has(v)) return "[circular]";
    if (depth >= b.maxDepth) {
      const what = Array.isArray(v) ? `a list of ${fmt(v.length)} items` : `an object with ${fmt(Object.keys(v).length)} fields`;
      cut.push(`${path}: ${what} below depth ${b.maxDepth} left out`);
      return Array.isArray(v) ? `[${fmt(v.length)} items left out]` : "[object left out]";
    }
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        let items = v;
        if (v.length > b.maxArray) {
          items = b.keep === "tail" ? v.slice(-b.maxArray) : v.slice(0, b.maxArray);
          cut.push(`${path}: kept the ${b.keep === "tail" ? "last" : "first"} ${fmt(b.maxArray)} of ${fmt(v.length)} items`);
        }
        const base = b.keep === "tail" ? v.length - items.length : 0;
        return items.map((x, i) => {
          const r = walk(x, child(path, base + i), depth + 1);
          return r === undefined ? null : r;
        });
      }
      const entries = Object.entries(v as Record<string, unknown>);
      let kept = entries;
      if (entries.length > b.maxArray) {
        kept = entries.slice(0, b.maxArray);
        cut.push(`${path}: kept the first ${fmt(b.maxArray)} of ${fmt(entries.length)} fields`);
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of kept) {
        const r = walk(x, child(path, k), depth + 1);
        if (r !== undefined) out[k] = r;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  const text = (s: string, path: string): string => {
    let t = s;
    if (b.maxLines > 0 && t.includes("\n")) {
      const lines = t.split("\n");
      if (lines.length > b.maxLines) {
        t = (b.keep === "tail" ? lines.slice(-b.maxLines) : lines.slice(0, b.maxLines)).join("\n");
        cut.push(`${path}: kept the ${b.keep === "tail" ? "last" : "first"} ${fmt(b.maxLines)} of ${fmt(lines.length)} lines`);
      }
    }
    if (t.length > b.maxString) {
      const dropped = t.length - b.maxString;
      t = b.keep === "tail" ? `…[${fmt(dropped)} chars cut] ${t.slice(-b.maxString)}` : `${t.slice(0, b.maxString)} …[${fmt(dropped)} chars cut]`;
      cut.push(`${path}: cut ${fmt(dropped)} of ${fmt(dropped + b.maxString)} characters`);
    }
    return t;
  };
  return walk(value, "$", 0);
}

// Caps a value for a model's context or a stored record and says what it removed. When the capped value is still over
// maxBytes, the per-string and per-list caps are halved (a few times) until it fits; failing that, a JSON preview of at
// most maxBytes stands in for it. Never throws (circular structures, BigInt and Dates included).
export function minimise<T = unknown>(value: T, budget: Budget | number = {}): Minimised {
  const given = typeof budget === "number" ? { maxBytes: budget } : budget;
  const b: Required<Budget> = { ...DEFAULT_BUDGET };
  for (const [k, v] of Object.entries(given) as [keyof Budget, unknown][]) {
    if (k === "keep") b.keep = v === "tail" ? "tail" : "head";
    else if (typeof v === "number" && Number.isFinite(v) && v > 0 && Object.hasOwn(DEFAULT_BUDGET, k)) (b as Record<string, unknown>)[k] = Math.floor(v);
  }
  let cut: string[] = [];
  let out = shrink(value, b, cut);
  let bytes = sizeOf(out);
  const total = bytes;
  for (let i = 0; i < 8 && bytes > b.maxBytes; i++) {
    const tighter = { ...b, maxString: Math.max(64, Math.floor(b.maxString / 2)), maxLines: Math.max(10, Math.floor(b.maxLines / 2)), maxArray: Math.max(5, Math.floor(b.maxArray / 2)) };
    if (tighter.maxString === b.maxString && tighter.maxLines === b.maxLines && tighter.maxArray === b.maxArray) break;
    Object.assign(b, tighter);
    cut = [];
    out = shrink(value, b, cut);
    bytes = sizeOf(out);
  }
  if (bytes > b.maxBytes) {
    let json = "";
    try {
      json = JSON.stringify(out) ?? "";
    } catch {
      json = "";
    }
    const room = Math.max(0, b.maxBytes - 200);
    let preview = json.slice(0, room);
    while (enc.encode(preview).length > room) preview = preview.slice(0, Math.floor(preview.length * 0.9));
    cut.push(`$: ${fmt(total)} bytes even after cutting; only a ${fmt(enc.encode(preview).length)}-byte preview is kept`);
    out = { truncated: true, preview };
    bytes = sizeOf(out);
  }
  return { value: out, cut, bytes };
}

// ---------- untrusted evidence ----------

// Everything read from the world (logs, tags, notes, CI output, READMEs, tool results) reaches a model inside this
// envelope; the system prompt says data inside it is evidence, never instructions. Wrapping is labelling, not
// protection: the policy engine and the tool layer are what keep an injected instruction from doing anything.
export interface Untrusted<T = unknown> {
  untrusted: true;
  source: string; // "logs.recent acme-staging/api", "tags of ecs:service/…"
  observedAt: number; // epoch ms the data was read
  data: T;
}

export function untrusted<T>(source: string, observedAt: number, data: T): Untrusted<T> {
  return { untrusted: true, source: String(source).slice(0, 300), observedAt: Number.isFinite(observedAt) ? observedAt : 0, data };
}

export const isUntrusted = (v: unknown): v is Untrusted => !!v && typeof v === "object" && (v as { untrusted?: unknown }).untrusted === true && Object.hasOwn(v, "data");

// Redact first (on the whole value, so a cut can't leave half a secret behind), then minimise, then wrap.
export function prepareEvidence<T>(source: string, observedAt: number, data: T, budget?: Budget | number): { evidence: Untrusted; findings: RedactionLabel[]; cut: string[]; bytes: number } {
  const r = redactDeep(data);
  const m = minimise(r.value, budget);
  return { evidence: untrusted(source, observedAt, m.value), findings: r.findings, cut: m.cut, bytes: m.bytes };
}
