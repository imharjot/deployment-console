// The console's AWS connection: which account it reads (the simulated one or yours), how it signs in to AWS, its home
// region and the other regions it reads. An environment variable that is set always decides its part: deployments
// pin the connection in their task definition or compose file. Otherwise an admin's choice in Settings → AWS
// connection decides, and otherwise the simulated account. Pure: src/lib/server/connection.ts applies it, the
// Settings page shows it.
import { ALL_ENABLED, MAX_REGIONS, REGION_CODE } from "./regions.ts";

export type Source = "aws" | "mock";
// How the console signs in: the SDK's default chain (a task or instance role, ~/.aws's default profile), a named
// profile from ~/.aws, or a role assumed from the default chain. Never keys: the console's database stores no AWS
// credentials.
export type SignIn = { kind: "chain" } | { kind: "profile"; profile: string } | { kind: "role"; roleArn: string; externalId?: string };
export type RegionsChoice = typeof ALL_ENABLED | string[];

// Settings key "connection". `rev` counts saves: every console sharing the database applies each save once.
export interface SavedConnection {
  source: Source;
  signIn?: SignIn;
  home?: string;
  regions?: RegionsChoice;
  rev: number;
  by: string;
  at: number;
}

// What a save asks for, before it is checked against the environment and AWS.
export interface ConnectionInput {
  source: Source;
  signIn?: SignIn;
  home?: string;
  regions?: RegionsChoice;
}

// process.env, or a test's stand-in: the variables below are the ones read.
export interface ConnectionEnv {
  readonly [name: string]: string | undefined;
  CONSOLE_SOURCE?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
  AWS_PROFILE?: string;
  AWS_ACCESS_KEY_ID?: string;
  CONSOLE_REGIONS?: string;
}

export type Origin = "env" | "settings" | "default";
export type Field = "source" | "signIn" | "home" | "regions";

export interface EffectiveConnection {
  source: Source;
  signIn: SignIn;
  home: string; // AWS's; the simulated account's is fixed (sources.ts homeRegion)
  regions?: RegionsChoice; // Settings' choice; CONSOLE_REGIONS and console.config.json come first (server/regions.ts)
  from: Record<Exclude<Field, "regions">, Origin>;
  locked: Partial<Record<Field, string>>; // field → the environment variable that decides it
}

// GET /api/connection and POST /api/connection/test (the Settings page reads them).
export interface ConnectionTest {
  ok: boolean;
  source: "aws" | "mock";
  identity?: { account: string; arn: string };
  regions?: { region: string; clusters?: number; more?: boolean; error?: string }[];
  suggestedHome?: string;
  problems?: string[];
  error?: string;
}

export interface ConnectionView {
  source: "aws" | "mock";
  signIn: SignIn;
  home: string; // the home region in use (the simulated account's is fixed)
  awsHome: string; // the one an AWS connection gets: what the form starts from
  regions: { list: string[]; allEnabled: boolean; from: "env" | "config" | "settings" | "default"; choice?: RegionsChoice; problems?: string[] };
  from: Record<Exclude<Field, "regions">, Origin>;
  locked: Partial<Record<Field, string>>; // field → what decides it instead of Settings (an env var or the config file)
  saved: { by: string; at: number } | null;
  identity?: { account: string; arn: string };
  identityError?: string;
  profiles: string[];
  scopeSince?: number;
}

export const DEFAULT_HOME = "us-east-1";
export const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
export const EXTERNAL_ID = /^[\w+=,.@:/-]{2,1224}$/;
export const PROFILE_NAME = /^[\w+=,.@/-]{1,128}$/;

// Empty counts as unset, as everywhere in the console's environment.
const set = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

export function resolveConnection(env: ConnectionEnv, saved?: SavedConnection | null): EffectiveConnection {
  const envSource = set(env.CONSOLE_SOURCE)?.toLowerCase();
  // A typo must not silently run the demo against nothing: only aws, mock or unset are accepted (sources.ts too).
  if (envSource && envSource !== "aws" && envSource !== "mock") throw new Error(`CONSOLE_SOURCE must be "aws" or "mock" (got "${env.CONSOLE_SOURCE}")`);
  const envHome = set(env.AWS_REGION) ? "AWS_REGION" : set(env.AWS_DEFAULT_REGION) ? "AWS_DEFAULT_REGION" : undefined;
  const envProfile = set(env.AWS_PROFILE);
  // Keys in the environment are a sign-in someone chose for this console: Settings can't replace them. Nor can it when
  // the environment pins CONSOLE_SOURCE=aws: a deployment that does signs in the way its environment says (a task role,
  // IRSA), and an admin mustn't be able to pick another identity the machine can reach.
  const envSignIn = envProfile ? "AWS_PROFILE" : set(env.AWS_ACCESS_KEY_ID) ? "AWS_ACCESS_KEY_ID" : envSource === "aws" ? "CONSOLE_SOURCE" : undefined;
  const signIn: SignIn = envProfile ? { kind: "profile", profile: envProfile } : envSignIn ? { kind: "chain" } : (saved?.signIn ?? { kind: "chain" });
  return {
    source: (envSource as Source | undefined) ?? saved?.source ?? "mock",
    signIn,
    home: (envHome && set(env[envHome])) ?? saved?.home ?? DEFAULT_HOME,
    ...(saved?.regions ? { regions: saved.regions } : {}),
    from: {
      source: envSource ? "env" : saved ? "settings" : "default",
      signIn: envSignIn ? "env" : saved?.signIn ? "settings" : "default",
      home: envHome ? "env" : saved?.home ? "settings" : "default",
    },
    locked: {
      ...(envSource ? { source: "CONSOLE_SOURCE" } : {}),
      ...(envSignIn ? { signIn: envSignIn } : {}),
      ...(envHome ? { home: envHome } : {}),
      ...(set(env.CONSOLE_REGIONS) ? { regions: "CONSOLE_REGIONS" } : {}),
    },
  };
}

// The connection a save would give: the input where the environment doesn't decide.
export function withInput(env: ConnectionEnv, input: ConnectionInput): EffectiveConnection {
  return resolveConnection(env, { ...input, rev: 0, by: "", at: 0 });
}

// The fields of `input` the environment decides differently (a save that would change nothing there is fine).
export function lockedConflicts(current: EffectiveConnection, input: ConnectionInput): string[] {
  const out: string[] = [];
  const { locked } = current;
  if (locked.source && input.source !== current.source) out.push(locked.source);
  if (input.source === "aws") {
    if (locked.signIn && input.signIn && !sameSignIn(input.signIn, current.signIn)) out.push(locked.signIn);
    if (locked.home && input.home && input.home !== current.home) out.push(locked.home);
    if (locked.regions && input.regions) out.push(locked.regions);
  }
  return out;
}

export const sameSignIn = (a: SignIn, b: SignIn) =>
  a.kind === b.kind && (a.kind !== "profile" || a.profile === (b as typeof a).profile) && (a.kind !== "role" || (a.roleArn === (b as typeof a).roleArn && (a.externalId ?? "") === ((b as typeof a).externalId ?? "")));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseSignIn(v: unknown, profiles?: readonly string[]): SignIn | string {
  if (!isObj(v)) return "signIn must be an object";
  if (v.kind === "chain") return { kind: "chain" };
  if (v.kind === "profile") {
    if (typeof v.profile !== "string" || !PROFILE_NAME.test(v.profile)) return "signIn.profile must be a profile name";
    // A profile this console can't see would only fail later, on every call.
    if (profiles && !profiles.includes(v.profile)) return `no profile "${v.profile}" in this console's AWS config files`;
    return { kind: "profile", profile: v.profile };
  }
  if (v.kind === "role") {
    if (typeof v.roleArn !== "string" || !ROLE_ARN.test(v.roleArn.trim())) return "signIn.roleArn must be an IAM role ARN (arn:aws:iam::123456789012:role/name)";
    const ext = typeof v.externalId === "string" ? v.externalId.trim() : undefined;
    if (ext && !EXTERNAL_ID.test(ext)) return "signIn.externalId must be 2-1224 letters, digits or +=,.@:/-";
    return { kind: "role", roleArn: v.roleArn.trim(), ...(ext ? { externalId: ext } : {}) };
  }
  return 'signIn.kind must be "chain", "profile" or "role"';
}

function parseRegionsChoice(v: unknown): { value: RegionsChoice } | { error: string } {
  if (v === ALL_ENABLED) return { value: ALL_ENABLED };
  if (!Array.isArray(v) || !v.every((r) => typeof r === "string")) return { error: `regions must be "${ALL_ENABLED}" or a list of region codes` };
  const list = [...new Set(v.map((r: string) => r.trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter((r) => !REGION_CODE.test(r));
  if (bad.length) return { error: `not region codes: ${bad.slice(0, 5).join(", ")}` };
  if (list.length > MAX_REGIONS) return { error: `at most ${MAX_REGIONS} regions` };
  return { value: list };
}

// A save's body, checked. `profiles`: the names this console can see (a profile must be one of them).
export function parseConnectionInput(body: unknown, profiles?: readonly string[]): { ok: true; value: ConnectionInput } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "expected a JSON object" };
  if (body.source !== "aws" && body.source !== "mock") return { ok: false, error: 'source must be "aws" or "mock"' };
  if (body.source === "mock") return { ok: true, value: { source: "mock" } };
  const value: ConnectionInput = { source: "aws" };
  if (body.signIn !== undefined) {
    const s = parseSignIn(body.signIn, profiles);
    if (typeof s === "string") return { ok: false, error: s };
    value.signIn = s;
  }
  if (body.home !== undefined) {
    const h = typeof body.home === "string" ? body.home.trim().toLowerCase() : "";
    if (!REGION_CODE.test(h)) return { ok: false, error: "home must be a region code such as eu-west-1" };
    value.home = h;
  }
  if (body.regions !== undefined && body.regions !== null) {
    const r = parseRegionsChoice(body.regions);
    if ("error" in r) return { ok: false, error: r.error };
    if (r.value === ALL_ENABLED || r.value.length) value.regions = r.value;
  }
  return { ok: true, value };
}

// The stored row; a damaged one counts as no choice (the simulated account) rather than a guess.
export function parseSaved(raw: string | null | undefined): SavedConnection | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.rev !== "number" || typeof v.by !== "string" || typeof v.at !== "number") return null;
  const input = parseConnectionInput(v);
  return input.ok ? { ...input.value, rev: v.rev, by: v.by, at: v.at } : null;
}

// Profile names in ~/.aws/config ("[default]", "[profile name]") and ~/.aws/credentials ("[name]"). Section headers
// only: nothing else in either file is read. sso-session and services sections aren't profiles.
export function profileNames(config = "", credentials = ""): string[] {
  const out = new Set<string>();
  const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:[#;].*)?$/;
  for (const line of config.split(/\r?\n/)) {
    const name = header.exec(line)?.[1];
    if (name === "default") out.add(name);
    else if (name?.startsWith("profile ")) out.add(name.slice(8).trim());
  }
  for (const line of credentials.split(/\r?\n/)) {
    const name = header.exec(line)?.[1];
    if (name) out.add(name);
  }
  return [...out].filter((n) => PROFILE_NAME.test(n)).sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
}

// The home region to suggest after a connection test: where most ECS clusters are, the current home on a tie.
export function suggestHome(regions: { region: string; clusters?: number }[], current?: string): string | undefined {
  let best: { region: string; clusters: number } | undefined;
  for (const r of regions) {
    const n = r.clusters ?? 0;
    if (n > 0 && (!best || n > best.clusters || (n === best.clusters && r.region === current))) best = { region: r.region, clusters: n };
  }
  return best?.region;
}

// What the console's data belongs to. Environment ids come from the home region's clusters, so a new home is a new
// scope even in the same account.
export const scopeKey = (source: Source, account: string, home: string) => `${source}:${account}:${home}`;

// A write from a page loaded before a switch to another account or home region: it sent the token GET /api/me gave it
// (x-console-connection), and that is no longer the console's. Reads never are; nor are signing in and out and one's own
// preferences, and callers that send no token (API and agent tokens, scripts) aren't this check's to refuse.
const PERSONAL = /^\/api\/(auth|me)(\/|$)/;
export function staleWrite(o: { method: string; path: string; sent: string | null; current: string }): boolean {
  if (o.sent === null || ["GET", "HEAD", "OPTIONS"].includes(o.method.toUpperCase()) || PERSONAL.test(o.path)) return false;
  return o.sent !== o.current;
}

// For the page and the audit log: never a key, and the external ID only as "set".
export function describeSignIn(s: SignIn): string {
  if (s.kind === "profile") return `profile ${s.profile}`;
  if (s.kind === "role") return `role ${s.roleArn}${s.externalId ? " (external ID set)" : ""}`;
  return "default credentials";
}
