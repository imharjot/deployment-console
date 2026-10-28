// The console's AWS connection: which account it reads (the simulated one or yours), how it signs in to AWS, its home
// region and the other regions it reads. An environment variable that is set always decides its part: deployments
// pin the connection in their task definition or compose file. Otherwise an admin's choice in Settings → AWS
// connection decides, and otherwise the simulated account. Pure: src/lib/server/connection.ts applies it, the
// Settings page shows it.
import { ALL_ENABLED, MAX_REGIONS, REGION_CODE } from "./regions.ts";

export type Source = "aws" | "mock";
// How the console signs in: the SDK's default chain (a task or instance role, ~/.aws's default profile), a named
// profile from ~/.aws, or a role assumed from the default chain; Settings calls them the machine's own login, a saved
// profile and switching into a role. Never keys: the console's database stores no AWS credentials.
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

// GET /api/connection/machine: who the machine's own login (the SDK's default chain) signs in as, or why it can't.
export interface MachineLogin {
  identity?: { account: string; arn: string };
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
  profileKinds: Record<string, ProfileKind>;
  canAddProfile: boolean; // a console run locally by one person (AUTH_MODE=dev) may save an access key as a profile
  externalId: string; // this console's, for roles made from its CloudFormation template (server/connection.ts)
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

// What keeps `arn` from being a role to switch into, worded so a person can fix it; undefined when it is one. The usual
// mistakes: the ARN of the user who would assume the role, and a session's ARN (what `aws sts get-caller-identity`
// prints) instead of its role's.
export function roleArnProblem(arn: string): string | undefined {
  const a = arn.trim();
  if (ROLE_ARN.test(a)) return undefined;
  const user = /^arn:aws[a-z-]*:iam::\d{12}:user\/(?:[^/]+\/)*([^/]+)$/.exec(a)?.[1];
  if (user) return `That's the ARN of the IAM user ${user}, and only a role can be assumed. Enter a role's ARN instead (arn:aws:iam::123456789012:role/name); to sign in as ${user} itself, use a saved profile or the machine's own login.`;
  const session = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\//.exec(a);
  if (session) return `That's the ARN of a session of the role ${session[3]}, not of the role itself: try arn:${session[1]}:iam::${session[2]}:role/${session[3]} (with the role's path, if it has one).`;
  return "Enter a role's ARN, such as arn:aws:iam::123456789012:role/name.";
}

// Who an identity ARN (sts:GetCallerIdentity's) is, for people: "user ops-bot", "role console-readonly"; anything else as
// it is.
export function describeArn(arn: string): string {
  const m = /^arn:aws[a-z-]*:(?:iam|sts)::\d{12}:(root|user|assumed-role|federated-user)(?:\/(.+))?$/.exec(arn);
  const parts = m?.[2]?.split("/") ?? [];
  if (m?.[1] === "root") return "the account's root user";
  if (m?.[1] === "user" && parts.length) return `user ${parts.at(-1)}`;
  if (m?.[1] === "assumed-role" && parts[0]) return `role ${parts[0]}`;
  if (m?.[1] === "federated-user" && parts[0]) return `federated user ${parts[0]}`;
  return arn;
}

// A sign-in that failed, for the page. When the SDK finds nothing at all to sign in with, the usual failure on a new
// host, its message ("Could not load credentials from any providers") doesn't say what to do: this does, and so for a
// role AWS won't let the console switch into, which AWS words the same whichever side refuses. `detail` is the error
// as the server words it (errText).
export function signInFailure(s: SignIn, e: { name?: unknown; message?: unknown } | null | undefined, detail: string): string {
  const name = String(e?.name ?? "");
  const none = name === "CredentialsProviderError" && /could not load credentials from any providers/i.test(String(e?.message ?? ""));
  if (s.kind === "role" && /AccessDenied/.test(name) && /sts:AssumeRole/.test(String(e?.message ?? "")))
    return `AWS didn't let this console's own login switch into ${s.roleArn}. The role's trust policy must name that login and the external ID (a role made from this console's CloudFormation template does; if the console now runs somewhere else, download the template again and update the stack), and the login itself must be allowed sts:AssumeRole on the role (on ECS, add it to the task role).`;
  if (!none) return `Couldn't sign in to AWS: ${detail}`;
  if (s.kind === "profile") return `The profile ${s.profile} gives this machine no AWS credentials. Check it where the console runs: aws sts get-caller-identity --profile ${s.profile}`;
  if (s.kind === "role")
    return "Switching into a role starts from this machine's own login, and it has none. On AWS, give the console an ECS task role or an EC2 instance profile allowed to assume the role; anywhere else, a saved profile can assume it (role_arn in ~/.aws/config).";
  return "This machine has no AWS login of its own. On AWS, give the console an ECS task role or an EC2 instance profile; anywhere else, set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY where it runs, or use a saved profile.";
}

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
    const roleArn = typeof v.roleArn === "string" ? v.roleArn.trim() : "";
    const problem = roleArnProblem(roleArn);
    if (problem) return problem;
    const ext = typeof v.externalId === "string" ? v.externalId.trim() : undefined;
    if (ext && !EXTERNAL_ID.test(ext)) return "signIn.externalId must be 2-1224 letters, digits or +=,.@:/-";
    return { kind: "role", roleArn, ...(ext ? { externalId: ext } : {}) };
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

// What kind of login a profile is, which decides how long it lasts: an access key (until it's deleted), temporary keys
// (until their session ends), a role switched into through another profile (renewed every hour), an IAM Identity Center
// (SSO) or `aws login` session (until that session ends), or a credential_process. Read from the setting names only,
// never their values. The SDK's order: a role_arn wins over keys.
export type ProfileKind = "role" | "keys" | "temporary-keys" | "process" | "sso" | "login" | "other";
export function profileKinds(config = "", credentials = ""): Record<string, ProfileKind> {
  const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:[#;].*)?$/;
  const settings = new Map<string, Set<string>>();
  const read = (text: string, nameOf: (h: string) => string | undefined) => {
    let cur: Set<string> | undefined;
    for (const line of text.split(/\r?\n/)) {
      const h = header.exec(line)?.[1];
      if (h !== undefined) {
        const name = nameOf(h);
        cur = name && PROFILE_NAME.test(name) ? (settings.get(name) ?? settings.set(name, new Set()).get(name)) : undefined;
        continue;
      }
      const key = /^\s*([A-Za-z_][\w-]*)\s*=/.exec(line)?.[1]?.toLowerCase();
      if (cur && key) cur.add(key);
    }
  };
  read(config, (h) => (h === "default" ? h : h.startsWith("profile ") ? h.slice(8).trim() : undefined));
  read(credentials, (h) => h);
  const kind = (k: Set<string>): ProfileKind =>
    k.has("role_arn") ? "role"
    : k.has("aws_access_key_id") ? (k.has("aws_session_token") ? "temporary-keys" : "keys")
    : k.has("credential_process") ? "process"
    : k.has("sso_session") || k.has("sso_start_url") ? "sso"
    : k.has("login_session") ? "login"
    : "other";
  return Object.fromEntries([...settings].map(([name, k]) => [name, kind(k)]));
}

// Settings → AWS connection → Add a profile: an IAM user's long-term access key, checked before it's written to the
// machine's AWS credentials file the way `aws configure` writes it. Strict, so nothing typed can add lines to the file.
const ACCESS_KEY_ID = /^AKIA[A-Z0-9]{12,124}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=]{40}$/;
export interface NewProfile {
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export function parseNewProfile(v: unknown): NewProfile | { error: string } {
  if (!isObj(v)) return { error: "expected a JSON object" };
  const name = typeof v.name === "string" ? v.name.trim() : "";
  const accessKeyId = typeof v.accessKeyId === "string" ? v.accessKeyId.trim() : "";
  const secretAccessKey = typeof v.secretAccessKey === "string" ? v.secretAccessKey.trim() : "";
  if (!PROFILE_NAME.test(name)) return { error: "Give the profile a name: letters, digits and +=,.@/_- (up to 128)." };
  if (/^ASIA/.test(accessKeyId))
    return { error: "That's a temporary key (it starts with ASIA): it needs a session token and stops working when its session ends. Use an IAM user's access key (AKIA…), or `aws login`." };
  if (!ACCESS_KEY_ID.test(accessKeyId)) return { error: "An access key ID starts with AKIA, followed by capital letters and digits." };
  if (!SECRET_ACCESS_KEY.test(secretAccessKey)) return { error: "A secret access key is 40 characters: letters, digits and / + =." };
  return { name, accessKeyId, secretAccessKey };
}
// The lines a new profile appends to the credentials file.
export const credentialsSection = (p: NewProfile) => `[${p.name}]\naws_access_key_id = ${p.accessKeyId}\naws_secret_access_key = ${p.secretAccessKey}\n`;

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
  return "the machine's own login";
}
