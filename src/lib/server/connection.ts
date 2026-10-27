// Settings → AWS connection: which account the console reads and how it signs in, changed without a restart.
// - loadConnection() (instrumentation.ts, before anything reads AWS) reads the saved choice; resolveConnection()
//   (src/lib/connection-rules.ts) lets every environment variable that is set decide its part.
// - testConnection() asks AWS who a candidate signs in as and where its ECS clusters are, with its own clients.
// - saveConnection() is admin only and audited. It refuses while changes are running, and only saves what AWS answers
//   for. It then switches: the generation moves on (connection-state.ts) and the caches are dropped.
// - ensureScope(): when the account or the home region (which names the environments) is new, the data the console
//   derived from the previous one is forgotten (forgetAccountData), before anything is recorded for the new one.
// - syncConnection(): the sampler's tick picks up a save made by another console sharing the database.
import "server-only";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  describeSignIn, lockedConflicts, parseConnectionInput, parseSaved, profileNames, resolveConnection, sameSignIn, scopeKey, suggestHome, withInput,
  type ConnectionInput, type ConnectionTest, type ConnectionView, type EffectiveConnection, type SavedConnection,
} from "../connection-rules.ts";
import { writeAudit } from "./audit.ts";
import { invalidate } from "./cache.ts";
import { connectionCredentials, credentialsFor } from "./connection-credentials.ts";
import { bumpGeneration, connectionState, generation } from "./connection-state.ts";
import { getDb, type Db } from "./db.ts";
import { HttpError, errText } from "./errors.ts";
import { ACCT as MOCK_ACCOUNT, MOCK_REGIONS } from "./providers/mock-names.ts";
import { consoleConfig } from "./discovery.ts";
import { consoleRegions } from "./regions.ts";
import { homeRegion, sourceKind } from "./sources.ts";

const KEY = "connection";
const isDemoConfig = (file?: string) => !!file && file.replaceAll("\\", "/").endsWith("examples/demo.console.config.json");
const SCOPE_KEY = "connection:scope";
const SWITCHED = "the console switched to another AWS account or home region";

const readRow = async (key: string, db?: Db) => (await (db ?? (await getDb())).get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]))?.value ?? null;
const writeRow = (db: Db, key: string, value: string) =>
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);

function parseScope(raw: string | null): { key: string; since: number } | undefined {
  try {
    const v = raw ? (JSON.parse(raw) as { key?: unknown; since?: unknown }) : undefined;
    return v && typeof v.key === "string" && typeof v.since === "number" ? { key: v.key, since: v.since } : undefined;
  } catch {
    return undefined;
  }
}

// The connection in use: the loaded choice, or the environment alone before loadConnection() ran.
export const effectiveConnection = (): EffectiveConnection => connectionState().effective ?? resolveConnection(process.env, connectionState().saved);

const sameConnection = (a: EffectiveConnection, b: EffectiveConnection) =>
  a.source === b.source && sameSignIn(a.signIn, b.signIn) && a.home === b.home && JSON.stringify(a.regions ?? null) === JSON.stringify(b.regions ?? null);

// Puts `saved` in effect; true when that changed the connection (and so everything was reset).
function apply(saved: SavedConnection | null): boolean {
  const s = connectionState();
  const before = effectiveConnection();
  s.saved = saved;
  s.effective = resolveConnection(process.env, saved);
  if (sameConnection(before, s.effective)) return false;
  s.identity = undefined;
  bumpGeneration(); // first, so nothing still running for the old connection can refill what is dropped next
  invalidate("");
  return true;
}

// Boot: before the sampler, the routes or the inventory read anything. instrumentation.ts retries while the database
// isn't up yet, then marks the connection unknown rather than let the console fall back to the simulated account.
export async function loadConnection(): Promise<void> {
  const s = connectionState();
  const db = await getDb();
  s.saved = parseSaved(await readRow(KEY, db));
  s.effective = resolveConnection(process.env, s.saved);
  s.scope = parseScope(await readRow(SCOPE_KEY, db)); // not checked yet: ensureScope() asks AWS who this connection is
  s.unloaded = false;
}

export const markConnectionUnknown = () => {
  connectionState().unloaded = true;
};

// The sampler's tick: another console sharing this database may have saved a new connection, the database may only
// now be up, and the scope may still be unchecked (AWS didn't answer at boot). One row read per tick.
export async function syncConnection(): Promise<void> {
  const s = connectionState();
  const db = await getDb();
  const saved = parseSaved(await readRow(KEY, db));
  const unknown = s.unloaded || s.saved === undefined;
  if (unknown || (saved?.rev ?? 0) !== (s.saved?.rev ?? 0)) {
    s.unloaded = false;
    apply(saved);
    s.scope = parseScope(await readRow(SCOPE_KEY, db));
    // Saved by another console: it checked the account and forgot the previous one's data in that same transaction.
    if (!unknown) s.scopeVerifiedGen = generation();
  }
  if (s.scopeVerifiedGen !== generation()) await ensureScope();
}

// A change starts on the connection the console is on (mutations.ts): when another console sharing the database saved a
// new one, this one follows it now, not at its sampler's next tick, and the change is refused: it was meant for the
// account the page showed.
export async function assertConnectionCurrent(): Promise<void> {
  const s = connectionState();
  if (s.saved === undefined) return; // never loaded: tests and scripts (an unknown connection is refused in sources.ts)
  const saved = parseSaved(await readRow(KEY));
  if ((saved?.rev ?? 0) === (s.saved?.rev ?? 0)) return;
  await syncConnection();
  throw new HttpError(409, "this console's AWS connection changed since the page loaded; reload it and try again");
}

// Who the connection in use signs in as (cached for its generation).
async function currentIdentity(): Promise<{ account: string; arn: string } | undefined> {
  const s = connectionState();
  if (sourceKind() === "mock") return { account: MOCK_ACCOUNT, arn: "" };
  if (s.identity) return s.identity;
  const p = await (await import("./aws.ts")).probeConnection(connectionCredentials, homeRegion());
  s.identity = { account: p.account, arn: p.arn, at: Date.now() };
  return s.identity;
}

// In `t`: records `key` (source, account, home region) as whose data the console holds. A new one forgets what the
// previous one left, on the audit log. The first one ever recorded owns what came before it (since 0): an upgrade loses
// nothing and keeps verifying what it had.
async function adoptScope(t: Db, key: string, by: string, now = Date.now()): Promise<{ scope: { key: string; since: number }; forgot: boolean }> {
  const stored = parseScope(await readRow(SCOPE_KEY, t));
  if (stored?.key === key) return { scope: stored, forgot: false };
  const scope = { key, since: stored ? now : 0 };
  if (stored) {
    await forgetAccountData(t, now);
    const entry = { env: "", target: "aws-connection", action: "connection.forget", user: by, params: { from: stored.key, to: key } };
    await writeAudit({ ...entry, at: now, phase: "intent" }, t);
    await writeAudit({ ...entry, at: now, phase: "result", result: "ok" }, t);
  }
  await writeRow(t, SCOPE_KEY, JSON.stringify(scope));
  return { scope, forgot: !!stored };
}

// Whose data the console holds, checked with AWS once per generation: at boot, and by the sampler until AWS answers
// (a switch from Settings checks it as it saves). A new account or home region forgets the previous one's data, then
// resets memory, so nothing the sampler or a page restored in the meantime survives.
export async function ensureScope(o: { account?: string } = {}): Promise<void> {
  const s = connectionState();
  const gen = generation();
  const account = o.account ?? (await currentIdentity())?.account;
  if (!account || generation() !== gen) return;
  const key = scopeKey(sourceKind(), account, homeRegion());
  const { scope, forgot } = await (await getDb()).tx((t) => adoptScope(t, key, "console"));
  s.scope = scope;
  if (forgot) {
    console.warn(JSON.stringify({ level: 30, msg: "connection: new account or home region, the previous one's derived data was forgotten", to: key }));
    bumpGeneration();
    invalidate("");
  }
  s.scopeVerifiedGen = generation();
}

// What the console derived from the previous account or home region and would otherwise apply to the new one's
// same-named environments and services: remembered task counts ("start" after "stop"), state history and observed
// spans (uptime), the costs snapshot, pending host launches, and approvals and grants nobody has used yet. The audit log,
// notes and the persisted cloud-map runs (kept per account) stay.
export async function forgetAccountData(t: Db, now: number): Promise<void> {
  await t.run("DELETE FROM settings WHERE key LIKE 'desired:%' OR key LIKE 'observed:%' OR key = 'costs:snapshot'");
  await t.run("DELETE FROM state_changes");
  await t.run("UPDATE host_reservations SET state = 'released', detail = ? WHERE state = 'pending'", [SWITCHED]);
  await t.run("UPDATE approvals SET status = 'expired', detail = ? WHERE status = 'pending'", [SWITCHED]);
  await t.run("UPDATE approval_grants SET invalidated_at = ?, invalidation_reason = ? WHERE consumed_at IS NULL AND invalidated_at IS NULL", [now, SWITCHED]);
}

// The profiles this console can use: section headers of the AWS config and credentials files. Only the names leave
// this function.
export async function listProfiles(): Promise<string[]> {
  const dir = join(homedir(), ".aws");
  const [config, credentials] = await Promise.all([
    readFile(process.env.AWS_CONFIG_FILE?.trim() || join(dir, "config"), "utf8").catch(() => ""),
    readFile(process.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || join(dir, "credentials"), "utf8").catch(() => ""),
  ]);
  return profileNames(config, credentials);
}

const lockedMessage = (vars: string[]) =>
  `${vars.join(" and ")} ${vars.length === 1 ? "is" : "are"} set in this console's environment and decide${vars.length === 1 ? "s" : ""} that; change or unset ${vars.length === 1 ? "it" : "them"} where the console runs`;

async function checkedInput(body: unknown): Promise<ConnectionInput> {
  const parsed = parseConnectionInput(body, await listProfiles());
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const conflicts = lockedConflicts(effectiveConnection(), parsed.value);
  if (conflicts.length) throw new HttpError(409, lockedMessage(conflicts));
  return parsed.value;
}

// Settings' "Test connection": the candidate's identity and its ECS clusters per enabled region. Changes nothing.
export async function testConnection(body: unknown): Promise<ConnectionTest> {
  const input = await checkedInput(body);
  const next = withInput(process.env, input);
  if (next.source === "mock") return { ok: true, source: "mock", identity: { account: MOCK_ACCOUNT, arn: "" }, regions: MOCK_REGIONS.map((region) => ({ region })) };
  try {
    const p = await (await import("./aws.ts")).probeConnection(credentialsFor(next.signIn, next.home), next.home, { regions: true });
    return { ok: true, source: "aws", identity: { account: p.account, arn: p.arn }, regions: p.regions, suggestedHome: suggestHome(p.regions ?? [], next.home), problems: p.problems };
  } catch (e) {
    return { ok: false, source: "aws", error: errText(e) };
  }
}

// An audited change, the way every console write is: the intent is on record before the change (an intent that can't be
// written refuses it), the setting and the "ok" result commit together.
async function audited(base: { action: string; user: string; ip?: string; params: Record<string, unknown> }, write: (t: Db) => Promise<unknown>) {
  const db = await getDb();
  const entry = { env: "", target: "aws-connection", ...base };
  try {
    await writeAudit({ ...entry, at: Date.now(), phase: "intent" }, db);
  } catch (e) {
    throw new HttpError(503, `audit log unavailable, change refused: ${errText(e)}`);
  }
  try {
    await db.tx(async (t) => {
      await write(t);
      await writeAudit({ ...entry, at: Date.now(), phase: "result", result: "ok" }, t);
    });
  } catch (e) {
    await writeAudit({ ...entry, at: Date.now(), phase: "result", result: "error", detail: errText(e).slice(0, 300) }, db).catch(() => {});
    throw e;
  }
}

// Nothing may be running on the connection a switch leaves: this console's changes, any console's operations, or an
// agent run that hasn't finished (its plan names the old account's resources).
async function refuseWhileBusy(db: Db): Promise<void> {
  const writes = connectionState().writes ?? 0;
  if (writes > 0) throw new HttpError(409, `${writes} change${writes === 1 ? " is" : "s are"} still running on this console; switch once ${writes === 1 ? "it finishes" : "they finish"}`);
  const running = Number((await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM operations WHERE state = 'running'"))?.n ?? 0);
  if (running > 0) throw new HttpError(409, `${running} change${running === 1 ? " is" : "s are"} still running; switch once ${running === 1 ? "it finishes" : "they finish"}`);
  const runs = Number((await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM agent_runs WHERE state NOT IN ('succeeded', 'failed', 'cancelled')"))?.n ?? 0);
  if (runs > 0) throw new HttpError(409, `${runs} agent run${runs === 1 ? " hasn't" : "s haven't"} finished; cancel ${runs === 1 ? "it" : "them"} in Automation or wait, then switch`);
}

// Admin only (the route checks). Switches at once, without a restart: the next request reads the new connection.
export async function saveConnection(body: unknown, by: { email: string; ip?: string }): Promise<ConnectionView> {
  const input = await checkedInput(body);
  const db = await getDb();
  const before = await readRow(KEY, db); // compared again as it is written: a save made meanwhile isn't overwritten
  const next = withInput(process.env, input);
  // AWS must answer for the new connection before anything changes: one that can't sign in would read nothing.
  let identity = { account: MOCK_ACCOUNT, arn: "" };
  if (next.source === "aws") {
    try {
      const p = await (await import("./aws.ts")).probeConnection(credentialsFor(next.signIn, next.home), next.home);
      identity = { account: p.account, arn: p.arn };
    } catch (e) {
      throw new HttpError(400, `AWS didn't accept this connection: ${errText(e)}`);
    }
  }
  const key = scopeKey(next.source, identity.account, next.source === "mock" ? MOCK_REGIONS[0] : next.home);
  const s = connectionState();
  if (s.switching) throw new HttpError(409, "another switch of the AWS connection is under way");
  s.switching = true; // from here no change may start on this console (mutations.ts)
  try {
    // Changes this console already started finish first (up to 30 s).
    for (const until = Date.now() + 30_000; (s.writes ?? 0) > 0 && Date.now() < until; ) await new Promise((r) => setTimeout(r, 100));
    await refuseWhileBusy(db);
    const saved: SavedConnection = { ...input, rev: (parseSaved(before)?.rev ?? 0) + 1, by: by.email, at: Date.now() };
    const params = { source: input.source, ...(input.source === "aws" ? { signIn: describeSignIn(next.signIn), home: next.home, regions: input.regions ?? "home only", account: identity.account } : {}) };
    let adopted: Awaited<ReturnType<typeof adoptScope>> | undefined;
    // The connection, whose data it is, and forgetting the previous account's: one transaction.
    await audited({ action: "connection.update", user: by.email, ip: by.ip, params }, async (t) => {
      const value = JSON.stringify(saved);
      const n = before === null
        ? await t.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [KEY, value])
        : await t.run("UPDATE settings SET value = ? WHERE key = ? AND value = ?", [value, KEY, before]);
      if (n !== 1) throw new HttpError(409, "someone changed the AWS connection meanwhile; reload the page and try again");
      adopted = await adoptScope(t, key, by.email);
    });
    // The same connection can still be a new account (a profile that now points elsewhere): memory resets either way.
    if (!apply(saved) && adopted?.forgot) {
      bumpGeneration();
      invalidate("");
    }
    if (adopted) s.scope = adopted.scope;
    s.scopeVerifiedGen = generation();
    if (next.source === "aws") s.identity = { ...identity, at: Date.now() };
  } finally {
    s.switching = false;
  }
  return connectionView();
}

export async function connectionView(): Promise<ConnectionView> {
  const s = connectionState();
  const eff = effectiveConnection();
  const [regions, profiles] = await Promise.all([consoleRegions(), listProfiles()]);
  let identity: ConnectionView["identity"];
  let identityError: string | undefined;
  try {
    const i = await currentIdentity();
    identity = i && { account: i.account, arn: i.arn };
  } catch (e) {
    identityError = errText(e);
  }
  return {
    source: eff.source,
    signIn: eff.signIn,
    home: homeRegion(),
    awsHome: eff.home,
    regions: { list: regions.regions, allEnabled: regions.allEnabled, from: regions.source, ...(eff.regions ? { choice: eff.regions } : {}), ...(regions.problems ? { problems: regions.problems } : {}) },
    from: eff.from,
    // The demo's bundled config decides the simulated account's regions only: it doesn't lock what Settings picks for AWS.
    locked: { ...eff.locked, ...(!eff.locked.regions && regions.source === "config" && !isDemoConfig(consoleConfig().file) ? { regions: "console.config.json" } : {}) },
    saved: s.saved ? { by: s.saved.by, at: s.saved.at } : null,
    ...(identity ? { identity } : {}),
    ...(identityError ? { identityError } : {}),
    profiles,
    ...(s.scope ? { scopeSince: s.scope.since } : {}),
  };
}
