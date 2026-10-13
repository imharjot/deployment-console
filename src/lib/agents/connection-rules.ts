// Provider connections (AGENT_ARCHITECTURE §4 "credential broker", §5, §6 "prompt injection and credentials"): which
// providers exist, how each authenticates, which endpoints a connection may reach, who may create, see, change and use
// one, and who pays. Pure (no Node or DOM APIs), so the broker (src/lib/server/agents/credentials.ts), the routes and
// the Automation → Connections form share one set of rules.
//
// A connection authenticates inference and billing only: it never grants AWS permissions, a role or an approval. The
// broker re-applies decideUse() every time a run or a person asks for a credential, so a revoke, a demotion, a changed
// endpoint registry or a stricter organisation policy takes effect at the next call. A run is bound to the connection
// it was started with: there is no fallback to another connection, provider or payer.
import { ROLES, isRole, type Role } from "../rbac.ts";
import type { RunState } from "./records.ts";

export type Provider =
  | "scripted"
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "ollama"
  | "bedrock"
  | "chatgpt-plan"
  | "runtime:claude-code"
  | "runtime:gemini-cli";

export type AuthKind = "api-key" | "aws-role" | "aws-keys" | "oauth-plan" | "local-runtime" | "none";
export type ConnectionScope = "personal" | "org";
export type Egress = "local" | "cloud";
export type ConnectionStatus = "active" | "needs_auth" | "revoked" | "error";

export const PROVIDER_IDS: readonly Provider[] = [
  "scripted", "anthropic", "openai", "openai-compatible", "ollama", "bedrock", "chatgpt-plan", "runtime:claude-code", "runtime:gemini-cli",
];
export const AUTH_KINDS: readonly AuthKind[] = ["api-key", "aws-role", "aws-keys", "oauth-plan", "local-runtime", "none"];
export const isProvider = (v: unknown): v is Provider => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
export const isAuthKind = (v: unknown): v is AuthKind => typeof v === "string" && (AUTH_KINDS as readonly string[]).includes(v);

// The built-in demo connection: with the simulated account only, every signed-in person may use a scripted model that
// runs inside the console (no provider, no network, no cost). It is never stored, can't be edited or revoked, and
// doesn't exist against a real account.
export const DEMO_CONNECTION_ID = "scripted:demo";
export const DEMO_SCRIPT = "incident-demo"; // src/lib/agents/inference/scripts/incident-demo.ts

export interface ProviderSpec {
  id: Provider;
  label: string;
  authKinds: readonly AuthKind[]; // the first is the form's default
  // builtin: the default endpoint (used when the form leaves the field empty); custom: whether another URL may be used
  // ("registered" = only an admin-registered entry, "registered-local" = an admin-registered loopback/private entry)
  endpoint?: { builtin?: string; custom: "registered" | "registered-local" };
  region?: true; // an AWS region is required (Bedrock)
  egress: Egress; // where prompts go (a registered local endpoint makes openai-compatible "local")
  personalOnly?: true; // a person's own sign-in (a plan, a CLI login): never an organisation connection
  adminOnly?: true; // only an admin may create it (it uses a login held by the machine the console runs on)
  mockOnly?: true; // only with the simulated account
  flag?: "CONSOLE_CHATGPT_PLAN"; // created only when this flag says eligible
  createVia?: "oauth"; // created by a sign-in flow, not the form
  secret?: { label: string; hint: string }; // what the write-only secret field holds
  note?: string; // shown with the form
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "anthropic", label: "Anthropic API", authKinds: ["api-key"], endpoint: { builtin: "https://api.anthropic.com", custom: "registered" }, egress: "cloud",
    secret: { label: "API key", hint: "An Anthropic API key (sk-ant-…). Billing goes to the key's organisation." },
  },
  {
    id: "openai", label: "OpenAI API", authKinds: ["api-key"], endpoint: { builtin: "https://api.openai.com", custom: "registered" }, egress: "cloud",
    secret: { label: "API key", hint: "An OpenAI API key (sk-…). Billing goes to the key's project." },
  },
  {
    id: "openai-compatible", label: "OpenAI-compatible endpoint", authKinds: ["api-key", "none"], endpoint: { custom: "registered" }, egress: "cloud",
    secret: { label: "API key", hint: "The endpoint's key, if it needs one." },
    note: "Only endpoints an admin registered. Compatibility claims don't promise the same tool calling, streaming or limits: test the connection.",
  },
  {
    id: "ollama", label: "Ollama", authKinds: ["none", "api-key"], endpoint: { custom: "registered-local" }, egress: "local",
    secret: { label: "API key", hint: "Only if your Ollama server requires one." },
    note: "A local Ollama can still send prompts to cloud models (its cloud models and web search). For local-only processing, turn Ollama's cloud features off and restrict its network egress.",
  },
  {
    id: "bedrock", label: "Amazon Bedrock", authKinds: ["aws-role", "aws-keys"], region: true, egress: "cloud",
    secret: { label: "Role or keys", hint: "A role (ARN and external id) or access keys that can only invoke Bedrock models — never the console's own AWS identity." },
    note: "Billed to the AWS account of the role or keys. A cross-region inference profile can process prompts outside the selected region.",
  },
  {
    id: "chatgpt-plan", label: "ChatGPT plan", authKinds: ["oauth-plan"], egress: "cloud", personalOnly: true, flag: "CONSOLE_CHATGPT_PLAN", createVia: "oauth",
    note: "Uses your ChatGPT plan's allowance through Sign in with ChatGPT. Only for eligible personal or local open-source installs; a shared hosted console isn't assumed eligible.",
  },
  {
    id: "runtime:claude-code", label: "Claude Code (local CLI)", authKinds: ["local-runtime"], egress: "cloud", personalOnly: true, adminOnly: true,
    note: "Runs the unmodified claude CLI signed in on the machine the console runs on; its subscription pays. Only connect it on a console you run for yourself.",
  },
  {
    id: "runtime:gemini-cli", label: "Gemini CLI (local)", authKinds: ["local-runtime"], egress: "cloud", personalOnly: true, adminOnly: true,
    note: "Runs the gemini CLI signed in on the machine the console runs on. Needs a version with HTTP MCP support.",
  },
  {
    id: "scripted", label: "Scripted model (demo and tests)", authKinds: ["none"], egress: "local", mockOnly: true,
    note: "A deterministic script that runs inside the console; only with the simulated account.",
  },
];

export const providerSpec = (p: Provider): ProviderSpec => PROVIDERS.find((s) => s.id === p)!;

// ---------- small shapes ----------

const own = (o: object, k: string) => Object.hasOwn(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;
export const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const SCRIPT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const atLeast = (role: Role, min: Role) => ROLES.indexOf(role) >= ROLES.indexOf(min);

// ---------- endpoints ----------

// An admin-registered model endpoint (settings key agents:endpoints). Personal connections use the built-in endpoints;
// an entry is for organisation connections unless an admin explicitly marks it `personal: true`. A URL typed into a
// connection form is never trusted on its own, and a model can never supply one.
export interface EndpointEntry {
  id: string;
  url: string; // normalised base URL: http(s), no credentials, query or fragment, no trailing slash
  label: string;
  providers: Provider[]; // which providers may use it
  local: boolean; // admin-allowed loopback/private addresses (every address must then be private); else public only
  personal: boolean; // personal connections may use it — only when an admin said so (default: organisation connections only)
  addedBy?: string;
  addedAt?: number;
}

// Providers that talk HTTP to an endpoint (Bedrock uses the AWS SDK, runtimes and plans have their own).
export const ENDPOINT_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "openai-compatible", "ollama"];

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

// Normalises a base URL or explains why it can't be one. Credentials, queries and fragments are refused (a key belongs
// in the connection's secret, where it is sealed and never shown); plain http only for a local endpoint.
export function normaliseEndpoint(raw: unknown, o: { local: boolean }): Checked<string> {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "the endpoint URL is required", field: "url" };
  const s = raw.trim();
  if (s.length > 300 || !PRINTABLE.test(s)) return { ok: false, error: "the endpoint URL is too long or has control characters", field: "url" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "the endpoint isn't a valid URL", field: "url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "the endpoint must be an http(s) URL", field: "url" };
  if (u.protocol === "http:" && !o.local) return { ok: false, error: "a cloud endpoint must use https (plain http is only for a local endpoint)", field: "url" };
  if (u.username || u.password) return { ok: false, error: "put credentials in the connection's secret, never in the URL", field: "url" };
  if (u.search || u.hash || s.includes("?") || s.includes("#")) return { ok: false, error: "the endpoint URL can't have a query or fragment", field: "url" };
  // URL() already resolved dot segments; the text as typed must not have had any either (it would point elsewhere).
  if (/\/\.\.?(\/|$)/i.test(s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")) || /%2e|%2f/i.test(u.pathname))
    return { ok: false, error: "the endpoint path can't contain . or .. segments or encoded slashes", field: "url" };
  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, value: `${u.protocol}//${u.host}${path}` };
}

export function checkEndpointEntry(raw: unknown, ids: Set<string>): Checked<EndpointEntry> {
  if (!isObject(raw)) return { ok: false, error: "each endpoint must be an object" };
  const local = own(raw, "local") ? raw.local === true : false;
  if (own(raw, "local") && typeof raw.local !== "boolean") return { ok: false, error: "local must be true or false", field: "local" };
  const url = normaliseEndpoint(own(raw, "url") ? raw.url : undefined, { local });
  if (!url.ok) return url;
  const label = own(raw, "label") && typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label || label.length > 80 || !PRINTABLE.test(label)) return { ok: false, error: "each endpoint needs a label of at most 80 characters", field: "label" };
  const providers = own(raw, "providers") ? raw.providers : undefined;
  if (!Array.isArray(providers) || !providers.length || !providers.every((p) => isProvider(p) && ENDPOINT_PROVIDERS.includes(p)))
    return { ok: false, error: `providers must list one or more of ${ENDPOINT_PROVIDERS.join(", ")}`, field: "providers" };
  if (providers.includes("ollama") && !local) return { ok: false, error: "an Ollama endpoint must be a local (loopback or private) endpoint", field: "local" };
  if (own(raw, "personal") && typeof raw.personal !== "boolean") return { ok: false, error: "personal must be true or false", field: "personal" };
  let id = own(raw, "id") && typeof raw.id === "string" ? raw.id : "";
  if (id && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return { ok: false, error: "an endpoint id is lower-case letters, digits and dashes", field: "id" };
  if (!id) id = slug(label, ids);
  if (ids.has(id)) return { ok: false, error: `two endpoints share the id "${id}"`, field: "id" };
  ids.add(id);
  return {
    ok: true,
    value: {
      id, url: url.value, label, providers: [...new Set(providers as Provider[])], local, personal: own(raw, "personal") ? raw.personal === true : false,
      ...(own(raw, "addedBy") && typeof raw.addedBy === "string" ? { addedBy: raw.addedBy.slice(0, 254) } : {}),
      ...(own(raw, "addedAt") && typeof raw.addedAt === "number" && Number.isFinite(raw.addedAt) ? { addedAt: raw.addedAt } : {}),
    },
  };
}

function slug(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "endpoint";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export const MAX_ENDPOINTS = 50;

export function checkEndpointList(raw: unknown): Checked<EndpointEntry[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "endpoints must be a list" };
  if (raw.length > MAX_ENDPOINTS) return { ok: false, error: `at most ${MAX_ENDPOINTS} endpoints` };
  const ids = new Set<string>();
  const out: EndpointEntry[] = [];
  const urls = new Set<string>();
  for (const [i, e] of raw.entries()) {
    const c = checkEndpointEntry(e, ids);
    if (!c.ok) return { ok: false, error: `endpoint ${i + 1}: ${c.error}`, field: c.field };
    if (urls.has(c.value.url)) return { ok: false, error: `endpoint ${i + 1}: ${c.value.url} is listed twice` };
    urls.add(c.value.url);
    out.push(c.value);
  }
  return { ok: true, value: out };
}

// Where a connection's endpoint comes from: the provider's built-in default, an admin-registered entry, or nothing
// (Bedrock, runtimes, plans, scripts). `undefined` endpoint on input means "the default".
export type EndpointChoice = { kind: "builtin"; url: string } | { kind: "registered"; url: string; entry: EndpointEntry } | { kind: "none" };

export function chooseEndpoint(provider: Provider, raw: unknown, scope: ConnectionScope, endpoints: readonly EndpointEntry[]): Checked<EndpointChoice> {
  const spec = providerSpec(provider);
  const given = raw === undefined || raw === null || raw === "" ? undefined : raw;
  if (!spec.endpoint) return given === undefined ? { ok: true, value: { kind: "none" } } : { ok: false, error: `${spec.label} connections don't take an endpoint`, field: "endpoint" };
  if (given === undefined) {
    if (spec.endpoint.builtin) return { ok: true, value: { kind: "builtin", url: spec.endpoint.builtin } };
    return { ok: false, error: `${spec.label} needs an endpoint an admin registered`, field: "endpoint" };
  }
  if (typeof given !== "string") return { ok: false, error: "endpoint must be a URL", field: "endpoint" };
  const asLocal = normaliseEndpoint(given, { local: true });
  if (!asLocal.ok) return { ok: false, error: asLocal.error, field: "endpoint" };
  const url = asLocal.value;
  if (spec.endpoint.builtin && url === spec.endpoint.builtin) return { ok: true, value: { kind: "builtin", url } };
  const entry = endpoints.find((e) => e.url === url);
  if (!entry) return { ok: false, error: `${url} isn't a registered endpoint — an admin registers custom model endpoints (Automation → Connections → Endpoints)`, field: "endpoint" };
  return usableEndpoint(provider, scope, entry);
}

// Re-checked on every use: an admin may narrow or remove an entry after connections were made with it.
export function usableEndpoint(provider: Provider, scope: ConnectionScope, entry: EndpointEntry): Checked<EndpointChoice> {
  const spec = providerSpec(provider);
  if (!entry.providers.includes(provider)) return { ok: false, error: `the endpoint "${entry.label}" isn't registered for ${spec.label}`, field: "endpoint" };
  if (scope === "personal" && !entry.personal) return { ok: false, error: `the endpoint "${entry.label}" is for organisation connections only — personal connections use the built-in endpoints`, field: "endpoint" };
  if (spec.endpoint?.custom === "registered-local" && !entry.local) return { ok: false, error: `${spec.label} must use a local (loopback or private) endpoint an admin allowed`, field: "endpoint" };
  return { ok: true, value: { kind: "registered", url: entry.url, entry } };
}

// The endpoint a stored connection uses now: builtin, still registered (and still allowed), or refused.
export function currentEndpoint(provider: Provider, scope: ConnectionScope, endpoint: string | null | undefined, endpoints: readonly EndpointEntry[]): Checked<EndpointChoice> {
  const spec = providerSpec(provider);
  if (!spec.endpoint) return { ok: true, value: { kind: "none" } };
  if (!endpoint) return spec.endpoint.builtin ? { ok: true, value: { kind: "builtin", url: spec.endpoint.builtin } } : { ok: false, error: `${spec.label} has no endpoint`, field: "endpoint" };
  if (spec.endpoint.builtin && endpoint === spec.endpoint.builtin) return { ok: true, value: { kind: "builtin", url: endpoint } };
  const entry = endpoints.find((e) => e.url === endpoint);
  if (!entry) return { ok: false, error: `the endpoint ${endpoint} is no longer registered by an admin`, field: "endpoint" };
  return usableEndpoint(provider, scope, entry);
}

// ---------- secrets ----------

// What the broker seals for a connection, by auth kind. Only the broker opens it, only for a purpose it checked, and
// hands adapters the inference interface's ConnectionSecret (src/lib/agents/inference/types.ts) built from it.
// A role is always assumed with the connection's own base keys (`source`): never with the console's AWS identity.
export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export type StoredSecret =
  | { kind: "api-key"; apiKey: string }
  | ({ kind: "aws-keys" } & AwsKeys)
  | { kind: "aws-role"; roleArn: string; externalId?: string; source: AwsKeys }
  | { kind: "oauth-plan"; tokens: Record<string, unknown> }
  | { kind: "none" };

const ACCESS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=]{40}$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const EXTERNAL_ID = /^[\w+=,.@:/-]{2,1224}$/;

function awsKeys(raw: Record<string, unknown>, field: string): Checked<AwsKeys> {
  const id = own(raw, "accessKeyId") && typeof raw.accessKeyId === "string" ? raw.accessKeyId.trim() : "";
  const sk = own(raw, "secretAccessKey") && typeof raw.secretAccessKey === "string" ? raw.secretAccessKey.trim() : "";
  const st = own(raw, "sessionToken") && typeof raw.sessionToken === "string" && raw.sessionToken.trim() ? raw.sessionToken.trim() : undefined;
  if (!ACCESS_KEY_ID.test(id)) return { ok: false, error: "accessKeyId must be an AWS access key id (AKIA… or ASIA…)", field: `${field}.accessKeyId` };
  if (!SECRET_ACCESS_KEY.test(sk)) return { ok: false, error: "secretAccessKey must be the 40-character secret access key", field: `${field}.secretAccessKey` };
  if (id.startsWith("ASIA") && !st) return { ok: false, error: "temporary keys (ASIA…) need their sessionToken", field: `${field}.sessionToken` };
  if (st !== undefined && (st.length > 4096 || !/^[A-Za-z0-9/+=]+$/.test(st))) return { ok: false, error: "sessionToken isn't a valid session token", field: `${field}.sessionToken` };
  return { ok: true, value: { accessKeyId: id, secretAccessKey: sk, ...(st ? { sessionToken: st } : {}) } };
}

// Validates the write-only secret field for an auth kind. Errors name the field, never echo the value.
export function checkSecret(authKind: AuthKind, raw: unknown, o: { required: boolean }): Checked<StoredSecret | undefined> {
  const absent = raw === undefined || raw === null || raw === "";
  if (authKind === "none" || authKind === "local-runtime") return absent ? { ok: true, value: { kind: "none" } } : { ok: false, error: "this connection doesn't take a secret", field: "secret" };
  if (absent) return o.required ? { ok: false, error: "the secret is required", field: "secret" } : { ok: true, value: undefined };
  if (authKind === "api-key") {
    const s = typeof raw === "string" ? raw.trim() : isObject(raw) && own(raw, "apiKey") && typeof raw.apiKey === "string" ? raw.apiKey.trim() : undefined;
    if (s === undefined) return { ok: false, error: "the API key must be a string", field: "secret" };
    if (s.length < 8 || s.length > 4096 || !/^[\x21-\x7e]+$/.test(s)) return { ok: false, error: "that doesn't look like an API key (8–4096 printable characters, no spaces)", field: "secret" };
    return { ok: true, value: { kind: "api-key", apiKey: s } };
  }
  if (!isObject(raw))
    return {
      ok: false,
      error: authKind === "aws-keys" ? "the secret must be { accessKeyId, secretAccessKey, sessionToken? }" : authKind === "aws-role" ? "the secret must be { roleArn, externalId?, source: { accessKeyId, secretAccessKey, sessionToken? } }" : "the secret must be an object",
      field: "secret",
    };
  if (authKind === "aws-keys") {
    const k = awsKeys(raw, "secret");
    return k.ok ? { ok: true, value: { kind: "aws-keys", ...k.value } } : k;
  }
  if (authKind === "aws-role") {
    const arn = own(raw, "roleArn") && typeof raw.roleArn === "string" ? raw.roleArn.trim() : "";
    const ext = own(raw, "externalId") && typeof raw.externalId === "string" && raw.externalId.trim() ? raw.externalId.trim() : undefined;
    if (!ROLE_ARN.test(arn)) return { ok: false, error: "roleArn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)", field: "secret.roleArn" };
    if (ext !== undefined && !EXTERNAL_ID.test(ext)) return { ok: false, error: "externalId must be 2–1224 characters of letters, digits and +=,.@:/-", field: "secret.externalId" };
    // The role is assumed with these keys, never with the console's own AWS identity.
    if (!own(raw, "source") || !isObject(raw.source)) return { ok: false, error: "a role needs the keys that assume it (source: { accessKeyId, secretAccessKey }) — the console's own AWS identity is never used for inference", field: "secret.source" };
    const k = awsKeys(raw.source, "secret.source");
    return k.ok ? { ok: true, value: { kind: "aws-role", roleArn: arn, ...(ext ? { externalId: ext } : {}), source: k.value } } : k;
  }
  // oauth-plan: an opaque token record written by the sign-in flow, never typed into a form
  const tokens = own(raw, "tokens") && isObject(raw.tokens) ? raw.tokens : raw;
  let size = 0;
  try {
    size = JSON.stringify(tokens).length;
  } catch {
    return { ok: false, error: "the token record must be JSON", field: "secret" };
  }
  if (size > 32_768) return { ok: false, error: "the token record is too large", field: "secret" };
  return { ok: true, value: { kind: "oauth-plan", tokens: { ...tokens } } };
}

// The account an AWS role or key belongs to (role ARNs carry it; keys don't) — for "who pays".
export const awsAccountOf = (s: StoredSecret | undefined) => (s?.kind === "aws-role" ? /^arn:aws[a-z-]*:iam::(\d{12}):/.exec(s.roleArn)?.[1] : undefined);

// ---------- the organisation's policy ----------

// settings key agents:connection-policy (admin). Defaults allow personal connections, every provider and cloud egress.
export interface ConnectionPolicy {
  personal: boolean; // false: personal connections can't be created or used (organisation connections only)
  localOnly: boolean; // true: only local-egress connections (local endpoints, scripted) may be used
  providers?: Provider[]; // when set: only these providers
}
export const DEFAULT_CONNECTION_POLICY: ConnectionPolicy = { personal: true, localOnly: false };

export function checkConnectionPolicy(raw: unknown): Checked<ConnectionPolicy> {
  if (!isObject(raw)) return { ok: false, error: "policy must be an object" };
  const out: ConnectionPolicy = { ...DEFAULT_CONNECTION_POLICY };
  for (const k of Object.keys(raw)) if (!["personal", "localOnly", "providers"].includes(k)) return { ok: false, error: `unknown policy field "${k}"`, field: k };
  if (own(raw, "personal")) {
    if (typeof raw.personal !== "boolean") return { ok: false, error: "personal must be true or false", field: "personal" };
    out.personal = raw.personal;
  }
  if (own(raw, "localOnly")) {
    if (typeof raw.localOnly !== "boolean") return { ok: false, error: "localOnly must be true or false", field: "localOnly" };
    out.localOnly = raw.localOnly;
  }
  if (own(raw, "providers") && raw.providers !== null) {
    if (!Array.isArray(raw.providers) || !raw.providers.every(isProvider)) return { ok: false, error: `providers must list some of ${PROVIDER_IDS.join(", ")}`, field: "providers" };
    out.providers = [...new Set(raw.providers as Provider[])];
  }
  return { ok: true, value: out };
}

export const parseConnectionPolicy = (raw: unknown): ConnectionPolicy => {
  const c = checkConnectionPolicy(raw);
  return c.ok ? c.value : { ...DEFAULT_CONNECTION_POLICY };
};

// ---------- creating ----------

export interface NewConnection {
  provider: Provider;
  authKind: AuthKind;
  label: string;
  scope: ConnectionScope;
  model?: string;
  endpoint?: string; // the chosen URL (builtin or registered); undefined for providers without one
  endpointLocal: boolean; // the endpoint is an admin-allowed local entry
  region?: string;
  backgroundOk: boolean;
  minRole: Role; // organisation connections: the least role that may use it; personal: unused
  egress: Egress;
  secret: StoredSecret;
}

export interface CreateContext {
  isAdmin: boolean;
  mock: boolean; // the simulated account
  chatgptPlan: boolean; // CONSOLE_CHATGPT_PLAN=eligible
  via: "form" | "oauth"; // the sign-in flow may create plan connections; the form never does
  endpoints: readonly EndpointEntry[];
  policy: ConnectionPolicy;
}

const FIELDS = new Set(["provider", "authKind", "label", "scope", "model", "endpoint", "region", "backgroundOk", "secret", "minRole"]);

// Validates a create request (the POST body, or the sign-in flow's record). The secret is checked and normalised but
// never echoed. Unknown fields are refused so a typo can't silently drop a setting.
export function checkNewConnection(raw: unknown, ctx: CreateContext): Checked<NewConnection> {
  if (!isObject(raw)) return { ok: false, error: "body must be a JSON object" };
  for (const k of Object.keys(raw)) if (!FIELDS.has(k)) return { ok: false, error: `unknown field "${k}"`, field: k };
  const provider = own(raw, "provider") ? raw.provider : undefined;
  if (!isProvider(provider)) return { ok: false, error: `provider must be one of ${PROVIDER_IDS.join(", ")}`, field: "provider" };
  const spec = providerSpec(provider);
  if (spec.mockOnly && !ctx.mock) return { ok: false, error: `${spec.label} connections exist only with the simulated account`, field: "provider" };
  if (spec.flag && !ctx.chatgptPlan) return { ok: false, error: `${spec.label} connections are turned off on this console (${spec.flag})`, field: "provider" };
  if (spec.createVia === "oauth" && ctx.via !== "oauth") return { ok: false, error: `${spec.label} connections are created by signing in (Automation → Connections → Sign in with ChatGPT)`, field: "provider" };
  if (spec.adminOnly && !ctx.isAdmin) return { ok: false, error: `only an admin can connect ${spec.label}: it uses the login of the machine the console runs on`, field: "provider" };
  if (ctx.policy.providers && !ctx.policy.providers.includes(provider)) return { ok: false, error: `the organisation's policy doesn't allow ${spec.label} connections`, field: "provider" };

  const authKind = own(raw, "authKind") && raw.authKind !== undefined ? raw.authKind : spec.authKinds[0];
  if (!isAuthKind(authKind) || !spec.authKinds.includes(authKind)) return { ok: false, error: `${spec.label} authenticates with ${spec.authKinds.join(" or ")}`, field: "authKind" };

  const label = own(raw, "label") && typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label || label.length > 80 || !PRINTABLE.test(label)) return { ok: false, error: "label is required (at most 80 characters)", field: "label" };

  const scopeRaw = own(raw, "scope") && raw.scope !== undefined ? raw.scope : "personal";
  if (scopeRaw !== "personal" && scopeRaw !== "org") return { ok: false, error: 'scope must be "personal" or "org"', field: "scope" };
  const scope: ConnectionScope = scopeRaw;
  if (scope === "org" && !ctx.isAdmin) return { ok: false, error: "only an admin can create an organisation connection", field: "scope" };
  if (scope === "org" && spec.personalOnly) return { ok: false, error: `${spec.label} is a personal sign-in and can't be an organisation connection`, field: "scope" };
  if (scope === "personal" && !ctx.policy.personal) return { ok: false, error: "the organisation's policy allows organisation connections only", field: "scope" };

  let model: string | undefined;
  if (own(raw, "model") && raw.model !== undefined && raw.model !== null && raw.model !== "") {
    if (typeof raw.model !== "string" || !(provider === "scripted" ? SCRIPT_RE : MODEL_RE).test(raw.model.trim()))
      return { ok: false, error: provider === "scripted" ? "model must be a script name (lower-case letters, digits, dashes)" : "model must be a model id (letters, digits and ._:/@+-, at most 128)", field: "model" };
    model = raw.model.trim();
  }
  if (provider === "scripted") model ??= DEMO_SCRIPT;

  let region: string | undefined;
  if (own(raw, "region") && raw.region !== undefined && raw.region !== null && raw.region !== "") {
    if (!spec.region) return { ok: false, error: `${spec.label} connections don't take a region`, field: "region" };
    if (typeof raw.region !== "string" || !REGION_RE.test(raw.region)) return { ok: false, error: "region must be an AWS region code (eu-west-1)", field: "region" };
    region = raw.region;
  }
  if (spec.region && !region) return { ok: false, error: `${spec.label} needs a region`, field: "region" };

  const ep = chooseEndpoint(provider, own(raw, "endpoint") ? raw.endpoint : undefined, scope, ctx.endpoints);
  if (!ep.ok) return ep;
  const endpointLocal = ep.value.kind === "registered" && ep.value.entry.local;
  const egress = egressOf(provider, ep.value);
  if (ctx.policy.localOnly && egress === "cloud") return { ok: false, error: "the organisation's policy allows only local model endpoints", field: "provider" };

  let backgroundOk = false;
  if (own(raw, "backgroundOk") && raw.backgroundOk !== undefined) {
    if (typeof raw.backgroundOk !== "boolean") return { ok: false, error: "backgroundOk must be true or false", field: "backgroundOk" };
    backgroundOk = raw.backgroundOk;
  }

  let minRole: Role = scope === "org" ? "developer" : "viewer";
  if (own(raw, "minRole") && raw.minRole !== undefined) {
    if (scope !== "org") return { ok: false, error: "minRole applies to organisation connections only", field: "minRole" };
    if (!isRole(raw.minRole)) return { ok: false, error: `minRole must be one of ${ROLES.join(", ")}`, field: "minRole" };
    minRole = raw.minRole;
  }

  const secret = checkSecret(authKind, own(raw, "secret") ? raw.secret : undefined, { required: true }); // none / local-runtime take none
  if (!secret.ok) return secret;

  return {
    ok: true,
    value: {
      provider, authKind, label, scope, ...(model ? { model } : {}), ...(ep.value.kind !== "none" ? { endpoint: ep.value.url } : {}), endpointLocal,
      ...(region ? { region } : {}), backgroundOk, minRole, egress, secret: secret.value ?? { kind: "none" },
    },
  };
}

// ---------- changing ----------

export interface ConnectionPatch {
  label?: string;
  model?: string | null; // null clears it
  backgroundOk?: boolean;
  minRole?: Role;
  secret?: StoredSecret; // present = rotate
}

const PATCH_FIELDS = new Set(["label", "model", "backgroundOk", "minRole", "secret"]);

export function checkPatch(raw: unknown, c: { provider: Provider; authKind: AuthKind; scope: ConnectionScope }): Checked<ConnectionPatch> {
  if (!isObject(raw)) return { ok: false, error: "body must be a JSON object" };
  const out: ConnectionPatch = {};
  for (const k of Object.keys(raw)) if (!PATCH_FIELDS.has(k)) return { ok: false, error: `"${k}" can't be changed — make a new connection instead`, field: k };
  if (own(raw, "label")) {
    const l = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!l || l.length > 80 || !PRINTABLE.test(l)) return { ok: false, error: "label is required (at most 80 characters)", field: "label" };
    out.label = l;
  }
  if (own(raw, "model")) {
    if (raw.model === null || raw.model === "") out.model = null;
    else if (typeof raw.model !== "string" || !(c.provider === "scripted" ? SCRIPT_RE : MODEL_RE).test(raw.model.trim())) return { ok: false, error: "model must be a model id (letters, digits and ._:/@+-, at most 128)", field: "model" };
    else out.model = raw.model.trim();
  }
  if (own(raw, "backgroundOk")) {
    if (typeof raw.backgroundOk !== "boolean") return { ok: false, error: "backgroundOk must be true or false", field: "backgroundOk" };
    out.backgroundOk = raw.backgroundOk;
  }
  if (own(raw, "minRole")) {
    if (c.scope !== "org") return { ok: false, error: "minRole applies to organisation connections only", field: "minRole" };
    if (!isRole(raw.minRole)) return { ok: false, error: `minRole must be one of ${ROLES.join(", ")}`, field: "minRole" };
    out.minRole = raw.minRole;
  }
  if (own(raw, "secret")) {
    if (providerSpec(c.provider).createVia === "oauth") return { ok: false, error: "plan sign-ins renew themselves; sign in again to replace one", field: "secret" };
    if (c.authKind === "none" || c.authKind === "local-runtime") return { ok: false, error: "this connection has no secret to rotate", field: "secret" };
    const s = checkSecret(c.authKind, raw.secret, { required: true });
    if (!s.ok) return s;
    out.secret = s.value;
  }
  if (!Object.keys(out).length) return { ok: false, error: "nothing to change" };
  return { ok: true, value: out };
}

// ---------- using ----------

// One use of a credential: a person testing it or listing its models, or a run's model call. `who` is re-read from the
// users table at the time of the call (for a run: the delegator), so a demotion or a disabled account applies at once.
export interface UseRequest {
  connection: {
    id: string;
    ownerId: string | null;
    scope: ConnectionScope;
    provider: Provider;
    egress: Egress;
    backgroundOk: boolean;
    status: ConnectionStatus;
    revoked: boolean;
    endpoint: string | null;
    minRole: Role;
    builtIn?: boolean;
  };
  who: { id: string; role?: Role; disabled?: boolean } | undefined; // undefined: the person no longer exists
  purpose: "run" | "test" | "models";
  run?: { id: string; connectionId: string | null; state: RunState; kind: string; delegatorId?: string }; // purpose run: the stored run
  interactive: boolean;
  policy: ConnectionPolicy;
  endpoints: readonly EndpointEntry[];
}

// `egress` is where prompts go with the endpoint as it is registered NOW (an admin may have re-classed an entry since the
// connection was made): the broker hands this, not the stored value, to the adapter.
export type UseDecision = { ok: true; endpoint: EndpointChoice; egress: Egress } | { ok: false; status: number; code: string; error: string };

// Where prompts go for a provider and an endpoint choice: a scripted model and an admin-allowed local entry stay local.
export const egressOf = (provider: Provider, ep: EndpointChoice): Egress => (provider === "scripted" || (ep.kind === "registered" && ep.entry.local) ? "local" : providerSpec(provider).egress);

const FINAL_RUN: readonly RunState[] = ["succeeded", "failed", "cancelled", "outcome_unknown"];

// The broker's checks, in order. Every refusal pauses a run (paused_auth) — never a fallback to another connection.
export function decideUse(r: UseRequest): UseDecision {
  const c = r.connection;
  const spec = providerSpec(c.provider);
  const no = (status: number, code: string, error: string): UseDecision => ({ ok: false, status, code, error });
  if (c.revoked || c.status === "revoked") return no(409, "connection_revoked", `the connection "${spec.label}" was disconnected — reconnect it or pick another connection`);
  if (c.status === "needs_auth" && r.purpose === "run") return no(409, "connection_needs_auth", "the provider refused this connection's credential — rotate it or sign in again");
  if (!r.who || r.who.disabled || !r.who.role) return no(403, "delegator_inactive", "the person this is done for no longer has access to the console");
  if (c.scope === "personal") {
    if (c.ownerId !== r.who.id) return no(403, "connection_forbidden", "this is someone else's personal connection — personal connections are never shared");
    if (!r.policy.personal) return no(403, "policy_personal", "the organisation's policy allows organisation connections only");
  } else if (!atLeast(r.who.role, c.minRole)) {
    return no(403, "connection_forbidden", `using this organisation connection needs the ${c.minRole} role`);
  }
  if (r.policy.providers && !r.policy.providers.includes(c.provider)) return no(403, "policy_provider", `the organisation's policy doesn't allow ${spec.label} connections`);
  const ep = currentEndpoint(c.provider, c.scope, c.endpoint, r.endpoints);
  if (!ep.ok) return no(403, "endpoint_unregistered", ep.error);
  // The stored class or the current one: either being cloud counts as cloud.
  const egress: Egress = c.egress === "cloud" || egressOf(c.provider, ep.value) === "cloud" ? "cloud" : "local";
  if (r.policy.localOnly && egress === "cloud") return no(403, "policy_egress", "the organisation's policy allows only local model endpoints");
  if (r.purpose === "run") {
    const run = r.run;
    if (!run) return no(404, "run_not_found", "no such run");
    if (run.connectionId !== c.id) return no(403, "connection_mismatch", "this run was started with another connection — a run never switches connections or payers");
    if (FINAL_RUN.includes(run.state)) return no(409, "run_finished", "this run has finished");
    if (run.delegatorId && run.delegatorId !== r.who.id) return no(403, "delegator_mismatch", "the run acts for someone else");
    if (!r.interactive && !c.backgroundOk) return no(403, "background_not_allowed", "this connection isn't allowed for background runs (turn on background use for it)");
  }
  return { ok: true, endpoint: ep.value, egress };
}

// ---------- showing ----------

export interface ConnectionView {
  id: string;
  provider: Provider;
  providerLabel: string;
  authKind: AuthKind;
  label: string;
  scope: ConnectionScope;
  owner: string; // the owner's email (personal), "organisation" (org) or "built-in"
  mine: boolean;
  model?: string;
  endpoint?: string;
  region?: string;
  egress: Egress;
  backgroundOk: boolean;
  minRole?: Role;
  status: ConnectionStatus;
  hasSecret: boolean;
  lastUsedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  revokedAt?: number;
  revokeConfirmed?: boolean;
  builtIn?: true;
  account?: { subject?: string; plan?: string };
  payer: string;
  canEdit: boolean;
  canRevoke: boolean;
  usable: boolean;
  why?: string; // why it isn't usable by the viewer
  notes?: string[];
}

// Who pays for this connection's inference: shown on every connection and every run (AGENT_ARCHITECTURE §10).
export function payerOf(c: { provider: Provider; scope: ConnectionScope; ownerEmail?: string; region?: string | null; account?: string; plan?: string; egress?: Egress }): string {
  const whose = c.scope === "org" ? "the organisation's" : c.ownerEmail ? `${c.ownerEmail}'s` : "the owner's";
  switch (c.provider) {
    case "scripted":
      return "nobody — a scripted model inside the console (no provider, no cost)";
    case "anthropic":
      return `${whose} Anthropic API account`;
    case "openai":
      return `${whose} OpenAI API project`;
    case "openai-compatible":
      return c.egress === "local" ? `${whose} own model server` : `${whose} account with the endpoint's provider`;
    case "ollama":
      return `${whose} own hardware (local Ollama) — cloud models it reaches bill its Ollama account`;
    case "bedrock":
      return `AWS account ${c.account ?? "of the role or keys"} (Bedrock${c.region ? `, ${c.region}` : ""})`;
    case "chatgpt-plan":
      return `${c.ownerEmail ? `${c.ownerEmail}'s` : "the owner's"} ChatGPT plan${c.plan ? ` (${c.plan})` : ""} — its usage allowance, never API billing`;
    case "runtime:claude-code":
      return "the Claude subscription signed in to Claude Code on the console's machine";
    case "runtime:gemini-cli":
      return "the Google account signed in to Gemini CLI on the console's machine";
  }
}

export function notesFor(provider: Provider, egress: Egress): string[] {
  const out: string[] = [];
  const spec = providerSpec(provider);
  if (spec.note) out.push(spec.note);
  if (egress === "local" && provider === "openai-compatible") out.push("A local endpoint can still forward prompts to cloud models; check the server's own settings.");
  return out;
}
