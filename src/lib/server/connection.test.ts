import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const mod = (f: string) => JSON.stringify(new URL(f, import.meta.url).href);

// The console's own database after a few days on one account, then forgetAccountData() for the next one.
const scenario = `
const { openSqlite, migrate } = await import(${mod("../db-core.ts")});
const { forgetAccountData } = await import(${mod("./connection.ts")});
const db = await openSqlite(":memory:");
await migrate(db);
for (const k of ["desired:production/api", "observed:production", "costs:snapshot", "connection", "connection:scope", "agents:enabled", "notes:x"]) {
  await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [k, "{}"]);
}
await db.run("INSERT INTO state_changes (id, env, rkey, state, at) VALUES ('s1', 'production', 'service:api', 'UP', 1)");
await db.run("INSERT INTO host_reservations (id, env, region, cluster, count, state, created_at, expires_at) VALUES ('h1', 'production', 'us-east-1', 'acme-prod', 1, 'pending', 1, 2), ('h2', 'production', 'us-east-1', 'acme-prod', 1, 'failed', 1, 2)");
await db.run("INSERT INTO approvals (id, op, input, requested_by, status, created_at) VALUES ('a1', 'services.restart', '{}', 'u1', 'pending', 1), ('a2', 'services.restart', '{}', 'u1', 'approved', 1)");
await db.run("INSERT INTO approval_grants (id, operation, requested_at) VALUES ('g1', 'services.restart', 1)");
await db.run("INSERT INTO approval_grants (id, operation, requested_at, consumed_at) VALUES ('g2', 'services.restart', 1, 5)");
await db.tx((t) => forgetAccountData(t, 100));
process.stdout.write(JSON.stringify({
  settings: (await db.all("SELECT key FROM settings ORDER BY key")).map((r) => r.key),
  states: Number((await db.get("SELECT COUNT(*) AS n FROM state_changes")).n),
  reservations: await db.all("SELECT id, state FROM host_reservations ORDER BY id"),
  approvals: await db.all("SELECT id, status FROM approvals ORDER BY id"),
  grants: (await db.all("SELECT id, invalidated_at FROM approval_grants ORDER BY id")).map((r) => [r.id, r.invalidated_at === null ? null : Number(r.invalidated_at)]),
}));
`;

test("a new account or home region forgets what the previous one left that would act on or describe the new one", () => {
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 60_000 }));
  // Remembered task counts, observed spans and the costs snapshot go; the connection itself and other settings stay.
  assert.deepEqual(out.settings, ["agents:enabled", "connection", "connection:scope", "notes:x"]);
  assert.equal(out.states, 0);
  // A pending host launch is released (not "failed": that would be an issue about the new account for a day).
  assert.deepEqual(out.reservations, [{ id: "h1", state: "released" }, { id: "h2", state: "failed" }]);
  assert.deepEqual(out.approvals, [{ id: "a1", status: "expired" }, { id: "a2", status: "approved" }]);
  assert.deepEqual(out.grants, [["g1", 100], ["g2", null]]);
});

// Save, scope and barrier on a throwaway console database: the first scope ever recorded forgets nothing; a later
// account change forgets, writes it on the audit log and moves the generation on; no change starts during a switch.
const lifecycle = `
const c = await import(${mod("./connection.ts")});
const st = await import(${mod("./connection-state.ts")});
const { getDb } = await import(${mod("./db.ts")});
const { mutate } = await import(${mod("./mutations.ts")});
const db = await getDb();
await c.loadConnection();
await db.run("INSERT INTO settings (key, value) VALUES ('desired:production/api', '3')");
const view = await c.saveConnection({ source: "mock" }, { email: "admin@example.com" });
const desiredKept = !!(await db.get("SELECT 1 AS x FROM settings WHERE key = 'desired:production/api'"));
const firstScope = JSON.parse((await db.get("SELECT value FROM settings WHERE key = 'connection:scope'")).value);
// Another account held this database before: the simulated one takes over.
await db.run("UPDATE settings SET value = ? WHERE key = 'connection:scope'", [JSON.stringify({ key: "aws:111111111111:eu-west-1", since: 1 })]);
const genBefore = st.generation();
await c.ensureScope();
const desiredGone = !(await db.get("SELECT 1 AS x FROM settings WHERE key = 'desired:production/api'"));
const audit = (await db.all("SELECT action, phase FROM audit WHERE target = 'aws-connection' ORDER BY at, phase")).map((r) => r.action + ":" + r.phase);
st.connectionState().switching = true;
const refused = await mutate({ action: "test", targets: [] }, async () => "ran").then(() => "ran", (e) => e.status);
st.connectionState().switching = false;
process.stdout.write(JSON.stringify({ source: view.source, saved: view.saved?.by, desiredKept, firstSince: firstScope.since, desiredGone, bumped: st.generation() > genBefore, audit, refused }));
`;

test("save records the first scope without forgetting; a later account change forgets, audits and resets; switching holds changes", () => {
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", lifecycle], { encoding: "utf8", timeout: 60_000, env: { ...process.env, CONSOLE_SOURCE: "", CONSOLE_SQLITE_PATH: ":memory:", AUTH_MODE: "dev" } }));
  assert.equal(out.source, "mock");
  assert.equal(out.saved, "admin@example.com");
  assert.equal(out.desiredKept, true, "the first scope ever recorded keeps what is there");
  assert.equal(out.firstSince, 0);
  assert.equal(out.desiredGone, true);
  assert.equal(out.bumped, true);
  assert.deepEqual(out.audit, ["connection.update:intent", "connection.update:result", "connection.forget:intent", "connection.forget:result"]);
  assert.equal(out.refused, 503);
});

// Add a profile: appended to the credentials file the way aws configure writes it, the file and its folder kept to
// their owner, and nothing of an existing profile changed (here a file that doesn't end in a newline).
test("a saved profile is appended, owner-only, after the profiles already there", async () => {
  const { mkdtempSync, readFileSync, statSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dc-profile-"));
  const file = join(dir, "aws", "credentials");
  const save = (f: string) => `
const { saveProfile } = await import(${mod("./connection.ts")});
await saveProfile(${JSON.stringify(f)}, { name: "deployment-console", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" });
`;
  const run = (src: string) => execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", src], { encoding: "utf8", timeout: 60_000 });
  run(save(file));
  assert.equal(readFileSync(file, "utf8"), "[deployment-console]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "aws")).mode & 0o777, 0o700);
  const existing = join(dir, "existing");
  writeFileSync(existing, "[default]\naws_access_key_id = AKIAEXISTING", { mode: 0o644 });
  run(save(existing));
  assert.equal(readFileSync(existing, "utf8"), "[default]\naws_access_key_id = AKIAEXISTING\n\n[deployment-console]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");
  assert.equal(statSync(existing).mode & 0o777, 0o600);
});
