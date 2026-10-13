// The credential broker (AGENT_ARCHITECTURE §4 "credential broker", §6 "prompt injection and credentials"; master plan
// §6 C5). Provider connections live in agent_connections with their credential sealed by secrets.ts (AES-256-GCM) and
// the id of the sealing key (key_version). Nothing outside this module opens one:
// - routes and views get metadata only (connectionView): never a secret, a sealed value or a fragment of either;
// - an adapter gets a ResolvedConnection from resolveConnection(id, purpose) and calls secret() per request; the
//   broker re-checks, at that moment, the owner or organisation scope, the run delegator's current right to use it,
//   revocation, background use, the organisation's egress policy and the endpoint registry (decideUse in
//   src/lib/agents/connection-rules.ts), binds a run to the one connection it was started with (no fallback), and
//   records an audit row "credential.use" (connection and run ids, never a value) — no audit row, no credential;
// - a revoke pauses the runs waiting on the connection (paused_auth) and never moves them to another connection.
//
// The built-in "scripted:demo" connection exists only with the simulated account: a read-only organisation connection
// to the scripted model (no secret, no network), so the assistant and the agent scenarios work out of the box.
//
// Personal connections are never a shared pool: only their owner uses them, admins may only revoke them. Organisation
// connections are created by admins and used by people with at least their minRole.
import "server-only";
import {
  DEFAULT_CONNECTION_POLICY, DEMO_CONNECTION_ID, DEMO_SCRIPT, awsAccountOf, checkConnectionPolicy, checkEndpointList, checkNewConnection, checkPatch, checkSecret,
  decideUse, isAuthKind, isProvider, notesFor, parseConnectionPolicy, payerOf, providerSpec,
  type AuthKind, type ConnectionPolicy, type ConnectionScope, type ConnectionStatus, type ConnectionView, type Egress, type EndpointChoice, type EndpointEntry, type Provider,
  type StoredSecret, type UseRequest,
} from "../../agents/connection-rules.ts";
import type { ConnectionSecret, ResolvedConnection } from "../../agents/inference/types.ts";
import type { AgentConnectionRow, RunState } from "../../agents/records.ts";
import { redact, marker } from "../../agents/redact.ts";
import { canTransitionRun } from "../../agents/run-state.ts";
import type { AgentPrincipal } from "../../agents/types.ts";
import { isRole, type Role, type User } from "../../rbac.ts";
import type { SafeInit } from "../../plugins/http.ts";
import { writeAudit } from "../audit.ts";
import { userById } from "../auth/users.ts";
import { getDb, newId, type Db } from "../db.ts";
import { HttpError, errText } from "../errors.ts";
import { derivedKey, seal, unseal } from "../secrets.ts";
import { sourceKind } from "../sources.ts";
import { EgressRefused, checkModelEndpoint, modelFetch, modelUrl } from "./egress.ts";
import { updateRun } from "./store.ts";

export { DEMO_CONNECTION_ID } from "../../agents/connection-rules.ts";

// ---------- errors ----------

// A refusal from the broker. Every one of them pauses a run (paused_auth) with this message — never a fallback.
export class CredentialError extends HttpError {
  readonly pause = "paused_auth" as const;
  constructor(status: number, code: string, message: string) {
    super(status, message);
    this.name = "CredentialError";
    this.code = code;
  }
}

// Works across bundles (the worker and the routes each load their own copy of this class).
export const isCredentialError = (e: unknown): e is CredentialError =>
  e instanceof CredentialError || (!!e && typeof e === "object" && (e as { name?: unknown }).name === "CredentialError" && typeof (e as { code?: unknown }).code === "string");

// ---------- shared state and change listeners ----------

// On globalThis: the routes and the worker (instrumentation) bundles each load this module.
const g = globalThis as {
  __consoleRemoteRevoke?: Map<string, RemoteRevoke>;
  __consoleCredentialUses?: Map<string, number>;
  __consoleConnectionListeners?: Set<(e: ConnectionChange) => void>;
};

// What changed about a connection, for whoever holds work on it (the runner stops a CLI or a model call of a paused run,
// the run view refreshes). Listeners live on globalThis — a revoke happens in a route's bundle, the worker runs in the
// instrumentation bundle — must not throw, and get an unsubscribe function.
export type ConnectionChange =
  | { type: "revoked"; connectionId: string; pausedRuns: string[]; at: number }
  | { type: "rotated"; connectionId: string; at: number }
  | { type: "status"; connectionId: string; status: "active" | "needs_auth" | "error"; at: number };
const listeners = (g.__consoleConnectionListeners ??= new Set());

export function onConnectionChange(f: (e: ConnectionChange) => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

function notify(e: ConnectionChange) {
  for (const f of [...listeners]) {
    try {
      f(e);
    } catch {
      // a listener's failure is its own; the change already happened
    }
  }
}

// ---------- settings ----------

const ENDPOINTS_KEY = "agents:endpoints";
const POLICY_KEY = "agents:connection-policy";

async function readSetting(key: string, db?: Db): Promise<unknown> {
  const row = await (db ?? (await getDb())).get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return null; // unreadable: callers fail closed (no endpoints) or fall back to the defaults
  }
}

const writeSetting = (db: Db, key: string, value: unknown) =>
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);

// The admin-registered model endpoints. An unreadable list counts as empty: custom endpoints stop working, built-in
// ones keep working.
export async function readEndpoints(db?: Db): Promise<EndpointEntry[]> {
  const raw = await readSetting(ENDPOINTS_KEY, db);
  if (raw === undefined) return [];
  const c = checkEndpointList(raw);
  return c.ok ? c.value : [];
}

export async function readConnectionPolicy(db?: Db): Promise<ConnectionPolicy> {
  const raw = await readSetting(POLICY_KEY, db);
  return raw === undefined ? { ...DEFAULT_CONNECTION_POLICY } : parseConnectionPolicy(raw);
}

export interface Actor {
  user: User;
  ip?: string;
}

// Admin: replaces the endpoint registry and/or the organisation's connection policy. A newly registered endpoint is
// resolved now and must match its class (a local entry only loopback/private addresses, a cloud entry only public
// ones; link-local never). Audited (URLs and flags only) in the same transaction as the change.
export async function saveConnectionSettings(raw: { endpoints?: unknown; policy?: unknown }, actor: Actor): Promise<{ endpoints: EndpointEntry[]; policy: ConnectionPolicy }> {
  if (actor.user.role !== "admin") throw new HttpError(403, "only an admin can register model endpoints or change the connection policy");
  let endpoints: EndpointEntry[] | undefined;
  let policy: ConnectionPolicy | undefined;
  if (raw.endpoints !== undefined) {
    const c = checkEndpointList(raw.endpoints);
    if (!c.ok) throw new HttpError(400, c.error);
    endpoints = c.value;
    for (const e of endpoints) {
      const found = redact(e.url);
      if (found.findings.length) throw new HttpError(400, `the endpoint "${e.label}" contains a credential (${found.findings.join(", ")}) — put it in the connection's secret`);
    }
  }
  if (raw.policy !== undefined) {
    const c = checkConnectionPolicy(raw.policy);
    if (!c.ok) throw new HttpError(400, `policy: ${c.error}`);
    policy = c.value;
  }
  if (!endpoints && !policy) throw new HttpError(400, "nothing to change: send endpoints and/or policy");
  const before = await readEndpoints();
  if (endpoints) {
    const known = new Map(before.map((e) => [e.url, e]));
    for (const e of endpoints) {
      const prev = known.get(e.url);
      if (prev && prev.local === e.local) {
        e.addedBy = prev.addedBy;
        e.addedAt = prev.addedAt;
        continue;
      }
      try {
        await checkModelEndpoint({ base: e.url, local: e.local }, { signal: AbortSignal.timeout(5_000) });
      } catch (err) {
        throw new HttpError(400, `the endpoint "${e.label}" can't be registered: ${err instanceof EgressRefused ? err.message : errText(err)}`);
      }
      e.addedBy = actor.user.email;
      e.addedAt = Date.now();
    }
  }
  const db = await getDb();
  return db.tx(async (t) => {
    const base = { env: "", target: "model connections", action: "agents.connection-settings", user: actor.user.email, ip: actor.ip };
    const params = {
      ...(endpoints ? { endpoints: endpoints.map((e) => ({ url: e.url, providers: e.providers, local: e.local, personal: e.personal })), removed: before.filter((b) => !endpoints!.some((e) => e.url === b.url)).map((b) => b.url) } : {}),
      ...(policy ? { policy } : {}),
    };
    try {
      await writeAudit({ ...base, at: Date.now(), phase: "intent", params }, t);
    } catch (e) {
      throw new HttpError(503, `audit log unavailable, nothing was changed: ${errText(e)}`);
    }
    if (endpoints) await writeSetting(t, ENDPOINTS_KEY, endpoints);
    if (policy) await writeSetting(t, POLICY_KEY, policy);
    await writeAudit({ ...base, at: Date.now(), phase: "result", result: "ok", params }, t);
    return { endpoints: endpoints ?? before, policy: policy ?? (await readConnectionPolicy(t)) };
  });
}

// ---------- sealing ----------

// Which key sealed a credential: a 31-bit id derived from the console's secret key (never the key itself). A
// credential sealed under another key (CONSOLE_SECRET_KEY changed) is reported as needing re-entry instead of failing
// with a decryption error.
export const sealingKeyVersion = () => derivedKey("agent-credential-key-version").readUInt32BE(0) & 0x7fffffff;

const sealSecret = (s: StoredSecret) => (s.kind === "none" ? { credential: null, keyVersion: null } : { credential: seal(JSON.stringify(s)), keyVersion: sealingKeyVersion() });

function openSecret(row: Pick<AgentConnectionRow, "credential" | "key_version" | "auth_kind">): StoredSecret {
  if (!row.credential) return { kind: "none" };
  if (row.key_version !== null && Number(row.key_version) !== sealingKeyVersion())
    throw new CredentialError(409, "credential_key_changed", "this connection's secret was sealed with a different console key — enter it again (rotate)");
  let s: StoredSecret;
  try {
    s = JSON.parse(unseal(row.credential)) as StoredSecret;
  } catch {
    throw new CredentialError(409, "credential_unreadable", "this connection's secret can't be opened — enter it again (rotate)");
  }
  const expected: Record<string, StoredSecret["kind"]> = { "api-key": "api-key", "aws-keys": "aws-keys", "aws-role": "aws-role", "oauth-plan": "oauth-plan" };
  if (!s || typeof s !== "object" || s.kind !== (expected[row.auth_kind] ?? "none")) throw new CredentialError(409, "credential_unreadable", "this connection's secret doesn't match its sign-in kind — enter it again");
  return s;
}

// The inference interface's view of a stored secret (src/lib/agents/inference/types.ts ConnectionSecret).
function toAdapterSecret(s: StoredSecret): ConnectionSecret {
  switch (s.kind) {
    case "api-key":
      return { kind: "api-key", apiKey: s.apiKey };
    case "aws-keys":
      return { kind: "aws", accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, ...(s.sessionToken ? { sessionToken: s.sessionToken } : {}) };
    case "aws-role":
      return { kind: "aws-role", roleArn: s.roleArn, ...(s.externalId ? { externalId: s.externalId } : {}), source: { ...s.source } };
    case "oauth-plan": {
      const t = s.tokens;
      const access = [t.access_token, t.accessToken].find((v): v is string => typeof v === "string" && v.length > 0);
      if (!access) throw new CredentialError(409, "connection_needs_auth", "this plan sign-in has no access token — sign in again");
      const account = [t.account_id, t.accountId].find((v): v is string => typeof v === "string" && v.length > 0);
      return { kind: "oauth", accessToken: access, ...(account ? { accountId: account } : {}) };
    }
    default:
      return { kind: "none" };
  }
}

// Every string in a stored secret that would identify it (for scrubbing provider messages).
function secretStrings(s: StoredSecret): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length >= 8) out.push(v); // shorter ones ("Bearer") identify nothing; an API key is at least 8
    else if (v && typeof v === "object") for (const x of Object.values(v)) add(x);
  };
  if (s.kind !== "none") add(s);
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

// Removes a connection's own secret (whole, or any 12-character piece of it a provider might echo) and everything
// redact() recognises. For adapter errors and diagnostics before they reach a person, a log or a run record.
export function scrubText(text: string, secrets: readonly string[]): string {
  let t = typeof text === "string" ? text : String(text ?? "");
  for (const s of secrets) {
    if (t.includes(s)) t = t.split(s).join(marker("secret-value"));
    if (s.length >= 16) for (let i = 0; i + 12 <= s.length; i += 6) {
      const piece = s.slice(i, i + 12);
      if (t.includes(piece)) t = t.split(piece).join(marker("secret-value"));
    }
  }
  return redact(t).text;
}

// ---------- rows ----------

const mock = () => sourceKind() === "mock";
const chatgptPlanOn = () => process.env.CONSOLE_CHATGPT_PLAN?.trim().toLowerCase() === "eligible";

interface Row extends AgentConnectionRow {
  owner_email?: string | null;
}

// The built-in demo connection as a row (never stored).
const demoRow = (): Row => ({
  id: DEMO_CONNECTION_ID, owner_id: null, scope: "org", provider: "scripted", auth_kind: "none", label: "Demo model (scripted)", endpoint: null, model: DEMO_SCRIPT,
  region: null, credential: null, key_version: null, egress: "local", background_ok: 1, eligibility: JSON.stringify({ minRole: "viewer" }), binding: null,
  status: "active", created_at: 0, updated_at: 0, last_used_at: null, revoked_at: null, revoke_confirmed: 1,
});

const COLS = "c.id, c.owner_id, c.scope, c.provider, c.auth_kind, c.label, c.endpoint, c.model, c.region, c.credential, c.key_version, c.egress, c.background_ok, c.eligibility, c.binding, c.status, c.created_at, c.updated_at, c.last_used_at, c.revoked_at, c.revoke_confirmed, u.email AS owner_email";

async function rowById(id: string, db?: Db): Promise<Row | undefined> {
  if (id === DEMO_CONNECTION_ID) return mock() ? demoRow() : undefined;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return undefined;
  return (db ?? (await getDb())).get<Row>(`SELECT ${COLS} FROM agent_connections c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?`, [id]);
}

const parse = <T>(s: string | null | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

const minRoleOf = (r: Row): Role => {
  const m = parse<{ minRole?: unknown }>(r.eligibility)?.minRole;
  return isRole(m) ? m : r.scope === "org" ? "admin" : "viewer"; // unreadable: the narrowest
};

// What a connection is bound to at the provider (a plan sign-in): subject, client registration, installation host,
// plan. Never an email.
export interface ConnectionBinding {
  subject?: string;
  clientRegistrationId?: string;
  installationHostId?: string;
  plan?: string;
  accountId?: string;
}
const BINDING_KEYS = ["subject", "clientRegistrationId", "installationHostId", "plan", "accountId"] as const;

function checkBinding(raw: unknown): ConnectionBinding | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "binding must be an object");
  const out: ConnectionBinding = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(BINDING_KEYS as readonly string[]).includes(k)) throw new HttpError(400, `binding can't hold "${k}"`);
    if (typeof v !== "string" || !v || v.length > 200 || /@.*\./.test(v)) throw new HttpError(400, `binding.${k} must be an opaque id (never an email)`);
    out[k as (typeof BINDING_KEYS)[number]] = v;
  }
  return out;
}

// The binding stored with a secret: a role's account id comes from its ARN (who pays, without opening the secret
// later); a plan sign-in's binding comes from its flow.
function bindingFor(secret: StoredSecret, given: ConnectionBinding | undefined): string | null {
  const account = awsAccountOf(secret);
  const b: ConnectionBinding = { ...given, ...(account ? { accountId: account } : {}) };
  if (secret.kind === "aws-keys" || (secret.kind === "aws-role" && !account)) delete b.accountId;
  return Object.keys(b).length ? JSON.stringify(b) : null;
}

const statusOf = (r: Row): ConnectionStatus => (r.revoked_at ? "revoked" : r.status === "needs_auth" || r.status === "error" ? r.status : "active");

function checkFor(r: Row, who: UseRequest["who"], purpose: UseRequest["purpose"], ctx: { policy: ConnectionPolicy; endpoints: EndpointEntry[] }, run?: UseRequest["run"], interactive = true): UseRequest {
  return {
    connection: {
      id: r.id, ownerId: r.owner_id, scope: r.scope === "org" ? "org" : "personal", provider: r.provider as Provider, egress: r.egress === "local" ? "local" : "cloud",
      backgroundOk: !!Number(r.background_ok), status: statusOf(r), revoked: !!r.revoked_at, endpoint: r.endpoint, minRole: minRoleOf(r), builtIn: r.id === DEMO_CONNECTION_ID,
    },
    who, purpose, run, interactive, policy: ctx.policy, endpoints: ctx.endpoints,
  };
}

// ---------- views ----------

// A connection as the routes show it: metadata, who pays, and whether the viewer may use, edit or revoke it. Never the
// credential, a sealed value or any part of either.
export function connectionView(r: Row, viewer: User, ctx: { policy: ConnectionPolicy; endpoints: EndpointEntry[] }): ConnectionView {
  const provider = r.provider as Provider;
  const scope: ConnectionScope = r.scope === "org" ? "org" : "personal";
  const builtIn = r.id === DEMO_CONNECTION_ID;
  const binding = parse<ConnectionBinding>(r.binding);
  const mine = scope === "personal" && r.owner_id === viewer.id;
  const admin = viewer.role === "admin";
  const status = statusOf(r);
  const decision = decideUse(checkFor(r, { id: viewer.id, role: viewer.role }, "test", ctx));
  const egress: Egress = decision.ok ? decision.egress : r.egress === "local" ? "local" : "cloud"; // as registered now
  return {
    id: r.id,
    provider: isProvider(provider) ? provider : "openai-compatible",
    providerLabel: isProvider(provider) ? providerSpec(provider).label : String(r.provider),
    authKind: isAuthKind(r.auth_kind) ? r.auth_kind : "none",
    label: r.label,
    scope,
    owner: builtIn ? "built-in" : scope === "org" ? "organisation" : (r.owner_email ?? "unknown"),
    mine,
    ...(r.model ? { model: r.model } : {}),
    ...(r.endpoint ? { endpoint: r.endpoint } : {}),
    ...(r.region ? { region: r.region } : {}),
    egress,
    backgroundOk: !!Number(r.background_ok),
    ...(scope === "org" ? { minRole: minRoleOf(r) } : {}),
    status,
    hasSecret: !!r.credential,
    ...(r.last_used_at ? { lastUsedAt: Number(r.last_used_at) } : {}),
    ...(builtIn ? { builtIn: true as const } : { createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }),
    ...(r.revoked_at ? { revokedAt: Number(r.revoked_at), revokeConfirmed: !!Number(r.revoke_confirmed) } : {}),
    ...(binding && (binding.subject || binding.plan) ? { account: { ...(binding.subject ? { subject: binding.subject } : {}), ...(binding.plan ? { plan: binding.plan } : {}) } } : {}),
    payer: payerOf({ provider, scope, ownerEmail: r.owner_email ?? undefined, region: r.region, account: binding?.accountId, plan: binding?.plan, egress }),
    canEdit: !builtIn && status !== "revoked" && (scope === "org" ? admin : mine),
    canRevoke: !builtIn && status !== "revoked" && (mine || admin),
    usable: decision.ok,
    ...(decision.ok ? {} : { why: decision.error }),
    notes: [
      ...notesFor(provider, egress),
      ...(r.revoked_at && !Number(r.revoke_confirmed) && r.auth_kind === "api-key" ? [`The console deleted its copy of the key; the key itself still works at the provider until you delete it there.`] : []),
      ...(r.revoked_at && !Number(r.revoke_confirmed) && r.auth_kind === "oauth-plan" ? ["The provider didn't confirm the sign-out; remove the app in your account's settings to be sure."] : []),
      ...(r.revoked_at && !Number(r.revoke_confirmed) && (r.auth_kind === "aws-keys" || r.auth_kind === "aws-role") ? ["The console deleted its copy of the AWS keys; deactivate them in IAM to be sure."] : []),
    ],
  };
}

async function settingsCtx(db?: Db) {
  const [policy, endpoints] = await Promise.all([readConnectionPolicy(db), readEndpoints(db)]);
  return { policy, endpoints };
}

// The viewer's own connections plus the organisation's (and, with the simulated account, the built-in demo). Admins
// may ask for everyone's (`all`) — metadata only, to revoke a leaver's connections.
export async function listConnections(viewer: User, o: { all?: boolean; includeRevoked?: boolean } = {}): Promise<ConnectionView[]> {
  const db = await getDb();
  const all = !!o.all && viewer.role === "admin";
  const where = [all ? "1 = 1" : "(c.owner_id = ? OR c.scope = 'org')", o.includeRevoked === false ? "c.revoked_at IS NULL" : "1 = 1"].join(" AND ");
  const rows = await db.all<Row>(`SELECT ${COLS} FROM agent_connections c LEFT JOIN users u ON u.id = c.owner_id WHERE ${where} ORDER BY c.revoked_at IS NOT NULL, c.created_at DESC LIMIT 500`, all ? [] : [viewer.id]);
  const ctx = await settingsCtx(db);
  const views = rows.filter((r) => all || r.scope === "org" || r.owner_id === viewer.id).map((r) => connectionView(r, viewer, ctx));
  return mock() ? [connectionView(demoRow(), viewer, ctx), ...views] : views;
}

// One connection the viewer may see: their own, the organisation's, or (admins) anyone's. Someone else's personal
// connection is 403 for everyone else.
export async function getConnection(id: string, viewer: User): Promise<ConnectionView> {
  const r = await rowById(id);
  if (!r) throw new HttpError(404, "no such connection");
  if (r.scope !== "org" && r.owner_id !== viewer.id && viewer.role !== "admin") throw new HttpError(403, "this is someone else's personal connection");
  return connectionView(r, viewer, await settingsCtx());
}

// ---------- create, change, rotate ----------

const auditBase = (action: string, r: { id: string; label: string }, actor: Actor | "system") => ({
  env: "", target: `connection ${r.label}`.slice(0, 300), action, user: actor === "system" ? "console" : actor.user.email, ip: actor === "system" ? undefined : actor.ip,
});

// Writes the intent, runs fn, writes the result — in one transaction, so no change lands without its record and a
// refused audit write changes nothing.
async function audited<T>(db: Db, base: ReturnType<typeof auditBase>, params: Record<string, unknown>, fn: (t: Db) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    try {
      await writeAudit({ ...base, at: Date.now(), phase: "intent", params }, t);
    } catch (e) {
      throw new HttpError(503, `audit log unavailable, nothing was changed: ${errText(e)}`);
    }
    const out = await fn(t);
    await writeAudit({ ...base, at: Date.now(), phase: "result", result: "ok", params }, t);
    return out;
  });
}

export interface CreateOptions {
  via?: "form" | "oauth"; // the sign-in flow (chatgpt-plan) passes "oauth"; the POST route never does
  binding?: ConnectionBinding;
}

// Creates a connection. The secret is validated, sealed and never returned; the audit row names the provider, scope
// and fields, never a value.
export async function createConnection(raw: unknown, actor: Actor, o: CreateOptions = {}): Promise<ConnectionView> {
  const db = await getDb();
  const ctx = await settingsCtx(db);
  const c = checkNewConnection(raw, { isAdmin: actor.user.role === "admin", mock: mock(), chatgptPlan: chatgptPlanOn(), via: o.via ?? "form", ...ctx });
  if (!c.ok) throw new HttpError(c.error.startsWith("only an admin") ? 403 : 400, c.error);
  const v = c.value;
  const binding = bindingFor(v.secret, checkBinding(o.binding));
  const id = newId();
  const now = Date.now();
  const sealed = sealSecret(v.secret);
  await audited(db, auditBase("connection.create", { id, label: v.label }, actor), { connection: id, provider: v.provider, scope: v.scope, authKind: v.authKind, endpoint: v.endpoint ?? null, model: v.model ?? null, region: v.region ?? null, backgroundOk: v.backgroundOk, secret: v.secret.kind !== "none" }, async (t) => {
    await t.run(
      `INSERT INTO agent_connections (id, owner_id, scope, provider, auth_kind, label, endpoint, model, region, credential, key_version, egress, background_ok, eligibility, binding, status, created_at, updated_at, last_used_at, revoked_at, revoke_confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 0)`,
      [id, actor.user.id, v.scope, v.provider, v.authKind, v.label, v.endpoint ?? null, v.model ?? null, v.region ?? null, sealed.credential, sealed.keyVersion, v.egress, v.backgroundOk ? 1 : 0, JSON.stringify({ minRole: v.minRole }), binding, now, now],
    );
  });
  return connectionView((await rowById(id, db))!, actor.user, ctx);
}

function editable(r: Row | undefined, actor: Actor, what: string): Row {
  if (!r) throw new HttpError(404, "no such connection");
  if (r.id === DEMO_CONNECTION_ID) throw new HttpError(403, "the built-in demo connection can't be changed");
  if (r.revoked_at) throw new HttpError(409, "this connection was disconnected — make a new one");
  if (r.scope === "org" ? actor.user.role !== "admin" : r.owner_id !== actor.user.id)
    throw new HttpError(403, r.scope === "org" ? `only an admin can ${what} an organisation connection` : `this is someone else's personal connection — only its owner can ${what} it`);
  return r;
}

// PATCH: label, model, background use, minRole (organisation), and a new secret (= rotate).
export async function updateConnection(id: string, raw: unknown, actor: Actor): Promise<ConnectionView> {
  const db = await getDb();
  const r = editable(await rowById(id, db), actor, "change");
  const p = checkPatch(raw, { provider: r.provider as Provider, authKind: r.auth_kind as AuthKind, scope: r.scope === "org" ? "org" : "personal" });
  if (!p.ok) throw new HttpError(400, p.error);
  const patch = p.value;
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (sql: string, v: unknown) => {
    sets.push(sql);
    args.push(v);
  };
  if (patch.label !== undefined) set("label = ?", patch.label);
  if (patch.model !== undefined) set("model = ?", patch.model);
  if (patch.backgroundOk !== undefined) set("background_ok = ?", patch.backgroundOk ? 1 : 0);
  if (patch.minRole !== undefined) set("eligibility = ?", JSON.stringify({ ...parse<Record<string, unknown>>(r.eligibility), minRole: patch.minRole }));
  if (patch.secret) {
    const s = sealSecret(patch.secret);
    set("credential = ?", s.credential);
    set("key_version = ?", s.keyVersion);
    set("binding = ?", bindingFor(patch.secret, parse<ConnectionBinding>(r.binding)));
    sets.push("status = 'active'");
  }
  const fields = Object.keys(patch).map((k) => (k === "secret" ? "secret (rotated)" : k));
  await audited(db, auditBase(patch.secret ? "connection.rotate" : "connection.update", r, actor), { connection: r.id, provider: r.provider, fields }, async (t) => {
    const n = await t.run(`UPDATE agent_connections SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND revoked_at IS NULL`, [...args, Date.now(), r.id]);
    if (!n) throw new HttpError(409, "this connection was disconnected meanwhile");
  });
  if (patch.secret) notify({ type: "rotated", connectionId: r.id, at: Date.now() });
  return connectionView((await rowById(id, db))!, actor.user, await settingsCtx(db));
}

// Replaces a connection's secret (a person's rotation, or a plan sign-in's token refresh: actor "system"). With
// `ifUpdatedAt` the swap is atomic against a concurrent one (409 when someone else rotated first) — rotating refresh
// tokens must never be overwritten by an older refresh. Returns the new updatedAt.
export async function rotateConnection(id: string, rawSecret: unknown, actor: Actor | "system", o: { ifUpdatedAt?: number } = {}): Promise<{ updatedAt: number }> {
  const db = await getDb();
  const r = await rowById(id, db);
  if (actor !== "system") editable(r, actor, "rotate");
  else if (!r || r.id === DEMO_CONNECTION_ID) throw new HttpError(404, "no such connection");
  else if (r.revoked_at) throw new CredentialError(409, "connection_revoked", "this connection was disconnected");
  const s = checkSecret(r!.auth_kind as AuthKind, rawSecret, { required: true });
  if (!s.ok) throw new HttpError(400, s.error);
  if (!s.value || s.value.kind === "none") throw new HttpError(400, "this connection has no secret to rotate");
  const sealed = sealSecret(s.value);
  const now = Math.max(Date.now(), Number(r!.updated_at) + 1); // strictly newer, so ifUpdatedAt always tells two rotations apart
  await audited(db, auditBase("connection.rotate", r!, actor), { connection: r!.id, provider: r!.provider, by: actor === "system" ? "token refresh" : "person" }, async (t) => {
    const cond = o.ifUpdatedAt !== undefined ? " AND updated_at = ?" : "";
    const n = await t.run(`UPDATE agent_connections SET credential = ?, key_version = ?, binding = ?, status = 'active', updated_at = ? WHERE id = ? AND revoked_at IS NULL${cond}`, [
      sealed.credential, sealed.keyVersion, bindingFor(s.value!, parse<ConnectionBinding>(r!.binding)), now, r!.id, ...(o.ifUpdatedAt !== undefined ? [o.ifUpdatedAt] : []),
    ]);
    if (!n) throw new HttpError(409, o.ifUpdatedAt !== undefined ? "the secret was rotated by someone else first" : "this connection was disconnected meanwhile");
  });
  notify({ type: "rotated", connectionId: r!.id, at: now });
  return { updatedAt: now };
}

// Adapters and the runner report what the provider said about a credential: "needs_auth" (refused or expired),
// "error" (misconfigured), "active" (a test passed again). Never brings back a revoked connection.
export async function markConnectionStatus(id: string, status: "active" | "needs_auth" | "error"): Promise<void> {
  if (id === DEMO_CONNECTION_ID) return;
  const n = await (await getDb()).run("UPDATE agent_connections SET status = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL AND status <> ?", [status, Date.now(), id, status]);
  if (n) notify({ type: "status", connectionId: id, status, at: Date.now() });
}

// ---------- revoke ----------

// A provider-side sign-out for providers that have one (the ChatGPT plan registers it). Resolves true only when the
// provider confirmed the revocation. Kept on globalThis: the route and the worker bundles each load this module.
export type RemoteRevoke = (secret: StoredSecret, c: { id: string; binding?: ConnectionBinding }) => Promise<boolean>;

const revokers = (g.__consoleRemoteRevoke ??= new Map());

export function registerRemoteRevoke(provider: Provider, fn: RemoteRevoke): () => void {
  revokers.set(provider, fn);
  return () => {
    if (revokers.get(provider) === fn) revokers.delete(provider);
  };
}

const PAUSABLE: readonly RunState[] = ["queued", "running", "waiting_approval", "waiting_external", "paused_budget"];
const PAUSED_WHY = "its model connection was disconnected — reconnect it or start the run again with another connection (runs never switch connections on their own)";

// Pauses every unfinished run that uses the connection (paused_auth). Runs never move to another connection.
async function pauseRuns(t: Db, connectionId: string): Promise<string[]> {
  const rows = await t.all<{ id: string; state: RunState }>(`SELECT id, state FROM agent_runs WHERE connection_id = ? AND state IN (${PAUSABLE.map(() => "?").join(", ")})`, [connectionId, ...PAUSABLE]);
  const paused: string[] = [];
  for (const run of rows) {
    if (!canTransitionRun(run.state, "paused_auth")) continue; // paused_budget stays paused; its next model call is refused anyway
    // Through the store so the pause publishes its `run` event; inside `t` it joins the revoke's transaction (a
    // savepoint), so the pause and its event commit with the audit intent. A run that moved on meanwhile is skipped.
    if (await updateRun(run.id, { state: "paused_auth", error: PAUSED_WHY }, { from: [run.state] }).then(() => true, () => false)) paused.push(run.id);
  }
  return paused;
}

// Disconnects a connection: the owner (personal) or an admin (any). The row is marked revoked and the runs waiting on
// it are paused in one transaction with the audit intent; then the provider-side sign-out runs where there is one, and
// the sealed credential is deleted. revoke_confirmed says honestly whether the provider confirmed (an API key can't be
// revoked from here: the console only forgets it). Calling it again finishes an interrupted revoke.
export async function revokeConnection(id: string, actor: Actor, o: { reason?: string } = {}): Promise<{ connection: ConnectionView; pausedRuns: string[] }> {
  const db = await getDb();
  const r = await rowById(id, db);
  if (!r) throw new HttpError(404, "no such connection");
  if (r.id === DEMO_CONNECTION_ID) throw new HttpError(403, "the built-in demo connection can't be disconnected");
  if (r.scope === "org" ? actor.user.role !== "admin" : r.owner_id !== actor.user.id && actor.user.role !== "admin")
    throw new HttpError(403, r.scope === "org" ? "only an admin can disconnect an organisation connection" : "this is someone else's personal connection");
  const reason = typeof o.reason === "string" ? o.reason.slice(0, 300) : undefined;
  const base = auditBase("connection.revoke", r, actor);
  let paused: string[] = [];
  if (!r.revoked_at) {
    paused = await db.tx(async (t) => {
      try {
        await writeAudit({ ...base, at: Date.now(), phase: "intent", reason, params: { connection: r.id, provider: r.provider, scope: r.scope } }, t);
      } catch (e) {
        throw new HttpError(503, `audit log unavailable, nothing was changed: ${errText(e)}`);
      }
      const now = Date.now();
      await t.run("UPDATE agent_connections SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL", [now, now, r.id]);
      return pauseRuns(t, r.id);
    });
    notify({ type: "revoked", connectionId: r.id, pausedRuns: paused, at: Date.now() });
  } else if (!r.credential) {
    return { connection: connectionView(r, actor.user, await settingsCtx(db)), pausedRuns: [] }; // already done
  }
  // Outside the transaction (a network call must never hold the DB): the provider-side sign-out, then forget the secret.
  let confirmed = r.auth_kind === "none" || r.auth_kind === "local-runtime";
  let remote: "confirmed" | "unconfirmed" | "none" = confirmed ? "none" : "unconfirmed";
  // The plan's revoker registers when chatgpt-plan.ts loads (the inference registry imports it); a bundle that never
  // loaded it loads it now, so a disconnect still signs the session out at OpenAI.
  if (r.provider === "chatgpt-plan" && !revokers.has("chatgpt-plan")) await import("./chatgpt-plan.ts").catch(() => undefined);
  const fn = revokers.get(r.provider);
  if (fn && r.credential) {
    try {
      confirmed = (await Promise.race([fn(openSecret(r), { id: r.id, binding: parse<ConnectionBinding>(r.binding) }), new Promise<boolean>((res) => setTimeout(() => res(false), 15_000).unref?.())])) === true;
    } catch {
      confirmed = false;
    }
    remote = confirmed ? "confirmed" : "unconfirmed";
  }
  await db.tx(async (t) => {
    await t.run("UPDATE agent_connections SET credential = NULL, key_version = NULL, revoke_confirmed = ?, updated_at = ? WHERE id = ?", [confirmed ? 1 : 0, Date.now(), r.id]);
    await writeAudit({ ...base, at: Date.now(), phase: "result", result: "ok", reason, params: { connection: r.id, provider: r.provider, pausedRuns: paused.length, remoteRevocation: remote } }, t);
  });
  return { connection: connectionView((await rowById(id, db))!, actor.user, await settingsCtx(db)), pausedRuns: paused };
}

// ---------- resolve ----------

// Why a credential is opened. A run's model call names the run (its delegator, kind and connection come from the
// stored run, never from the caller); a person testing a connection or listing its models names themselves.
export type ConnectionPurpose =
  | { kind: "run"; runId: string; principal?: AgentPrincipal }
  | { kind: "test" | "models"; user: User };

interface BrokerExtras {
  purpose: ConnectionPurpose["kind"];
  runId?: string;
  payer: string;
  // fetch() for this connection's endpoint only: a fixed API path ("/v1/messages"), never a URL (src/lib/server/agents/
  // egress.ts — pinned addresses, egress class enforced, redirects refused).
  fetch(path: string, init?: Omit<SafeInit, "redirect">): Promise<Response>;
  // The text with this connection's secret (and anything redact() recognises) removed — for provider error messages.
  scrub(text: string): Promise<string>;
  // A plan sign-in's token record, for its adapter's refresh: read it with its version, replace it only if nobody else
  // did first (rotating refresh tokens).
  tokens?: { read(): Promise<{ tokens: Record<string, unknown>; version: number }>; replace(next: Record<string, unknown>, version: number): Promise<{ version: number }> };
}

export type RuntimeProvider = "runtime:claude-code" | "runtime:gemini-cli";
export type BrokeredConnection = (ResolvedConnection & BrokerExtras) | (Omit<ResolvedConnection, "provider"> & BrokerExtras & { provider: RuntimeProvider });

const USE_AUDIT_WINDOW_MS = 10 * 60_000;
const uses = (g.__consoleCredentialUses ??= new Map());

// Records "credential.use" (connection id, run id or person, purpose — never a value) at most once per connection,
// run (or person) and purpose every 10 minutes. A refused audit write refuses the credential.
async function auditUse(r: Row, purpose: ConnectionPurpose, actorEmail: string) {
  const key = `${r.id}|${purpose.kind === "run" ? `run:${purpose.runId}` : `user:${purpose.user.id}`}|${purpose.kind}`;
  const now = Date.now();
  const last = uses.get(key);
  if (last !== undefined && now - last < USE_AUDIT_WINDOW_MS) return;
  try {
    await writeAudit({
      at: now, phase: "result", env: "", target: `connection ${r.label}`.slice(0, 300), action: "credential.use", user: actorEmail, result: "ok",
      params: { connection: r.id, provider: r.provider, purpose: purpose.kind, ...(purpose.kind === "run" ? { run: purpose.runId } : {}) },
    });
  } catch (e) {
    throw new CredentialError(503, "audit_unavailable", `the audit log is unavailable, so the credential wasn't used: ${errText(e)}`);
  }
  uses.set(key, now);
  if (uses.size > 5_000) for (const [k, at] of uses) if (now - at >= USE_AUDIT_WINDOW_MS) uses.delete(k);
}

interface RunInfo {
  id: string;
  state: RunState;
  kind: string;
  connection_id: string | null;
  principal: string | null;
  initiator_id: string | null;
}

// Every check for one use (decideUse): the connection as stored now, the run as stored now, the person re-read from the
// users table now, the organisation's policy and the endpoint registry as they are now. Throws CredentialError.
async function checkUse(id: string, purpose: ConnectionPurpose, db: Db) {
  const r = await rowById(id, db);
  if (!r) throw new CredentialError(404, "connection_not_found", "no such connection");
  const ctx = await settingsCtx(db);
  let run: UseRequest["run"];
  let whoId: string;
  let interactive = true;
  if (purpose.kind === "run") {
    const row = await db.get<RunInfo>("SELECT id, state, kind, connection_id, principal, initiator_id FROM agent_runs WHERE id = ?", [purpose.runId]);
    if (!row) throw new CredentialError(404, "run_not_found", "no such run");
    const stored = parse<Partial<AgentPrincipal>>(row.principal);
    const delegatorId = stored?.delegatorId ?? row.initiator_id ?? "";
    if (purpose.principal && (purpose.principal.delegatorId !== delegatorId || (purpose.principal.runId !== undefined && purpose.principal.runId !== row.id)))
      throw new CredentialError(403, "delegator_mismatch", "the run acts for someone else");
    run = { id: row.id, connectionId: row.connection_id, state: row.state, kind: row.kind, delegatorId };
    whoId = delegatorId;
    interactive = row.kind === "assistant";
  } else {
    whoId = purpose.user.id;
  }
  const person = whoId ? await userById(whoId, db) : undefined;
  const who = person ? { id: person.id, role: isRole(person.role) ? person.role : ("viewer" as Role), disabled: !!Number(person.disabled) } : undefined;
  const decision = decideUse(checkFor(r, who, purpose.kind, ctx, run, interactive));
  if (!decision.ok) throw new CredentialError(decision.status, decision.code, decision.error);
  return { r, person: person!, decision };
}

const grantOf = (d: { endpoint: EndpointChoice }) => (d.endpoint.kind === "none" ? undefined : { base: d.endpoint.url, local: d.endpoint.kind === "registered" && d.endpoint.entry.local });

// Opens a connection for one purpose after every check (decideUse). For a run: the run must exist, be unfinished and
// have been started with exactly this connection; the delegator is the run's stored principal, re-read from the users
// table now (a demotion or a disabled account applies at once); workflow runs are background use. Refusals throw
// CredentialError (pause the run: paused_auth — never a fallback). secret(), fetch() and tokens.read() run every check
// again at the moment of use, so a revoke, a demotion, a cancelled run or a stricter policy stops the next request of
// an adapter that still holds the connection.
export async function resolveConnection(id: string, purpose: ConnectionPurpose): Promise<BrokeredConnection> {
  const db = await getDb();
  const { r, person, decision } = await checkUse(id, purpose, db);
  await auditUse(r, purpose, person.email);
  await db.run("UPDATE agent_connections SET last_used_at = ? WHERE id = ?", [Date.now(), r.id]).catch(() => 0);

  const ep = decision.endpoint;
  let known: string[] = [];
  // Re-checked and re-read at the moment of use: a revoke, a rotation, a demotion or a finished run since resolve()
  // applies to the next request (and is audited like the first use, at most once per window).
  const recheck = async () => {
    const d = await getDb();
    const now = await checkUse(r.id, purpose, d);
    await auditUse(now.r, purpose, now.person.email);
    return now;
  };
  const current = async (): Promise<StoredSecret> => {
    if (r.id === DEMO_CONNECTION_ID) return { kind: "none" };
    const s = openSecret((await recheck()).r);
    known = secretStrings(s);
    return s;
  };
  const binding = parse<ConnectionBinding>(r.binding);
  const base = {
    id: r.id,
    authKind: r.auth_kind,
    label: r.label,
    ...(r.model ? { model: r.model } : {}),
    ...(ep.kind === "registered" ? { endpoint: ep.url, endpointRegistered: true } : {}),
    ...(r.region ? { region: r.region } : {}),
    egress: decision.egress,
    scope: (r.scope === "org" ? "org" : "personal") as ConnectionScope,
    ...(r.owner_id ? { ownerId: r.owner_id } : {}),
    purpose: purpose.kind,
    ...(purpose.kind === "run" ? { runId: purpose.runId } : {}),
    payer: payerOf({ provider: r.provider as Provider, scope: r.scope === "org" ? "org" : "personal", ownerEmail: r.owner_email ?? undefined, region: r.region, plan: binding?.plan, egress: r.egress === "local" ? "local" : "cloud" }),
    secret: async () => toAdapterSecret(await current()),
    fetch: async (path: string, init: Omit<SafeInit, "redirect"> = {}) => {
      if (ep.kind === "none") throw new CredentialError(400, "no_endpoint", `${providerSpec(r.provider as Provider).label} connections have no HTTP endpoint`);
      modelUrl(ep.url, path); // a model-supplied URL is refused before anything else happens
      const grant = grantOf((await recheck()).decision); // the endpoint's class as registered now
      return modelFetch(grant!, path, init);
    },
    scrub: async (text: string) => {
      if (!known.length && r.credential) {
        try {
          await current();
        } catch {
          // revoked or unreadable: scrub with what redact() knows
        }
      }
      return scrubText(text, known);
    },
    ...(r.auth_kind === "oauth-plan"
      ? {
          tokens: {
            read: async () => {
              const now = (await recheck()).r;
              const s = openSecret(now);
              known = secretStrings(s);
              return { tokens: s.kind === "oauth-plan" ? { ...s.tokens } : {}, version: Number(now.updated_at) };
            },
            replace: async (next: Record<string, unknown>, version: number) => {
              const out = await rotateConnection(r.id, { tokens: next }, "system", { ifUpdatedAt: version });
              return { version: out.updatedAt };
            },
          },
        }
      : {}),
  };
  if (r.provider === "runtime:claude-code" || r.provider === "runtime:gemini-cli") return { ...base, provider: r.provider };
  return { ...base, provider: r.provider as ResolvedConnection["provider"] };
}

// Removes a connection's own secret and every recognised credential from a text, for a person who may see the
// connection (adapter errors on the test route). Never throws.
export async function scrubForConnection(id: string, text: string): Promise<string> {
  try {
    const r = await rowById(id);
    return scrubText(text, r?.credential && !r.revoked_at ? secretStrings(openSecret(r)) : []);
  } catch {
    return redact(String(text ?? "")).text;
  }
}
