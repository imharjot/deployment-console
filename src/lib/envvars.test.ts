import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  applyJsonKeys, backingOfFile, backingOfSecret, buildRefIndex, duplicateNames, editEnvFile, envFileVars, groupEdits, jsonKeyValue, nameProblem, parseDotenv,
  parseEnvFile, parseSecretRef, refLabel, sharingOf, summarize, withJsonKey,
} from "./envvars.ts";

test("secret references: SSM names and ARNs, Secrets Manager with json key and version", () => {
  assert.deepEqual(parseSecretRef("/acme/api/DATABASE_URL"), { kind: "ssm", name: "/acme/api/DATABASE_URL" });
  assert.deepEqual(parseSecretRef("arn:aws:ssm:us-east-1:123456789012:parameter/acme/api/DATABASE_URL"), { kind: "ssm", name: "/acme/api/DATABASE_URL" });
  assert.deepEqual(parseSecretRef("arn:aws:ssm:us-east-1:123456789012:parameter/DATABASE_URL"), { kind: "ssm", name: "DATABASE_URL" }, "a non-hierarchical name has no leading /");
  assert.deepEqual(parseSecretRef("DATABASE_URL"), { kind: "ssm", name: "DATABASE_URL" });
  const sm = parseSecretRef("arn:aws:secretsmanager:us-east-1:123456789012:secret:acme/api-AbC123:password::");
  assert.equal(sm.kind, "secretsmanager");
  assert.equal(sm.kind === "secretsmanager" && sm.jsonKey, "password");
  assert.equal(sm.kind === "secretsmanager" && sm.secretId, "arn:aws:secretsmanager:us-east-1:123456789012:secret:acme/api-AbC123");
  assert.equal(refLabel(sm), "acme/api#password");
  const whole = parseSecretRef("arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe-key-Zz9Yy8");
  assert.equal(whole.kind === "secretsmanager" && whole.jsonKey, undefined);
  assert.equal(refLabel(whole), "stripe-key");
});

test("json keys inside a secret: read one, update one, keep the rest", () => {
  const s = JSON.stringify({ username: "app", password: "old", port: 5432 });
  assert.equal(jsonKeyValue(s, "password"), "old");
  assert.equal(jsonKeyValue(s, "port"), "5432");
  assert.throws(() => jsonKeyValue(s, "host"), /not found/);
  assert.deepEqual(JSON.parse(withJsonKey(s, "password", "new")), { username: "app", password: "new", port: 5432 });
  assert.throws(() => withJsonKey("[1]", "a", "b"), /not a JSON object/);
});

test("names: valid, invalid, reserved", () => {
  assert.equal(nameProblem("DATABASE_URL"), undefined);
  assert.equal(nameProblem("_x1"), undefined);
  assert.match(nameProblem("1ABC")!, /valid/);
  assert.match(nameProblem("MY-VAR")!, /valid/);
  assert.match(nameProblem("ECS_CONTAINER_METADATA_URI")!, /reserved/);
});

test("env files: values are literal like ECS reads them; edits keep untouched lines byte for byte", () => {
  const text = "# api settings\nexport PORT=3000\nPORT=3000\nGREETING=\"hello world\"\n  DATABASE_URL=postgres://a:b@db:5432/app\n\nLOG_LEVEL=info\n";
  const lines = parseEnvFile(text);
  assert.deepEqual(envFileVars(lines).map((l) => [l.name, l.value]), [["PORT", "3000"], ["GREETING", '"hello world"'], ["DATABASE_URL", "postgres://a:b@db:5432/app"], ["LOG_LEVEL", "info"]]);
  const out = editEnvFile(text, { LOG_LEVEL: "debug", NEW_FLAG: "on" }, ["PORT"]);
  assert.equal(out, "# api settings\nexport PORT=3000\nGREETING=\"hello world\"\n  DATABASE_URL=postgres://a:b@db:5432/app\n\nLOG_LEVEL=debug\nNEW_FLAG=on\n");
  assert.equal(editEnvFile("", { A: "1" }, []), "A=1\n");
});

test("dotenv text from the editor: last one wins, problems per line, comments ignored", () => {
  const r = parseDotenv("# c\nA=1\nB = 2\n1BAD=x\nA=3\n\nECS_AGENT=1\nQ=\"kept\"\nexport E=1");
  assert.deepEqual(r.vars, [{ name: "A", value: "3" }, { name: "Q", value: '"kept"' }]);
  assert.equal(r.problems.length, 4);
});

test("summaries hold names only; duplicates across environment and secrets are caught", () => {
  const current = [
    { container: "api", name: "PORT", source: "plain" as const },
    { container: "api", name: "LOG", source: "file" as const, file: "s3://b/api.env" },
    { container: "api", name: "STRIPE_KEY", source: "secretsmanager" as const },
  ];
  const s = summarize(
    { plain: [{ container: "api", set: { PORT: "8080", NEW: "x" }, remove: ["OLD"] }], secrets: [{ container: "api", name: "DB_PASSWORD", value: "s3cret" }, { container: "api", name: "STRIPE_KEY", value: "sk" }], files: [{ container: "api", file: "s3://b/api.env", set: { LOG: "debug" }, remove: [] }] },
    current,
  );
  assert.deepEqual(s.map((x) => [x.source, x.added, x.changed, x.removed]), [
    ["plain", ["NEW"], ["PORT"], ["OLD"]],
    ["file", [], ["LOG"], []],
    ["ssm", [], ["DB_PASSWORD"], []],
    ["secretsmanager", [], ["STRIPE_KEY"], []],
  ]);
  assert.ok(!JSON.stringify(s).includes("s3cret") && !JSON.stringify(s).includes("8080"), "no values in the plan");
  assert.deepEqual(duplicateNames([{ name: "A" }, { name: "B" }], [{ name: "B" }]), ["B"]);
});

test("env files with Windows line endings keep them", () => {
  assert.equal(editEnvFile("A=1\r\nB=2\r\n", { B: "3" }, []), "A=1\r\nB=3\r\n");
});

// ---------- shared backing objects (REVIEW R02, R05, F34) ----------

test("backing objects: every way of naming one parameter, secret or file gives one key", () => {
  const ssmName = backingOfSecret("/acme/shared/JWT", "us-east-1");
  assert.deepEqual(ssmName, { key: "ssm:us-east-1/acme/shared/JWT", kind: "ssm", label: "/acme/shared/JWT" });
  assert.equal(backingOfSecret("arn:aws:ssm:us-east-1:123456789012:parameter/acme/shared/JWT", "eu-west-1").key, ssmName.key, "an ARN names its own region");
  assert.equal(backingOfSecret("/acme/shared/JWT", "eu-west-1").key, "ssm:eu-west-1/acme/shared/JWT", "a bare name lives in the task's region");
  const sm = "arn:aws:secretsmanager:us-east-1:123456789012:secret:acme/api-AbC123";
  const whole = backingOfSecret(sm, "us-east-1");
  assert.deepEqual(whole, { key: "secret:us-east-1/acme/api", kind: "secretsmanager", label: "acme/api" });
  for (const ref of [`${sm}:password::`, `${sm}:username::`, `${sm}::AWSCURRENT:`]) assert.equal(backingOfSecret(ref, "us-east-1").key, whole.key, ref);
  assert.deepEqual(backingOfFile("arn:aws:s3:::acme-config/staging/api.env"), { key: "s3:acme-config/staging/api.env", kind: "s3", label: "s3://acme-config/staging/api.env" });
});

const consumer = (env: string, service: string, o: { protected?: boolean; self?: boolean; secrets?: string[]; files?: string[]; unreadable?: boolean } = {}) => ({
  env, region: "us-east-1", cluster: `acme-${env}`, service, protected: o.protected ?? false, self: o.self ?? false,
  containers: o.unreadable ? undefined : [{ secrets: (o.secrets ?? []).map((valueFrom) => ({ valueFrom })), files: o.files ?? [] }],
});

test("sharing: the strongest consumer decides; an unreadable protected (or console) service fails closed", () => {
  const p = "/acme/shared/JWT";
  const index = buildRefIndex({
    services: [
      consumer("staging", "api", { secrets: [p], files: ["arn:aws:s3:::acme-config/shared.env"] }),
      consumer("staging", "worker", { secrets: [`arn:aws:ssm:us-east-1:123456789012:parameter${p}`] }),
      consumer("production", "api", { protected: true, secrets: [p] }),
      consumer("production", "deployment-console", { protected: true, self: true, files: ["arn:aws:s3:::acme-config/shared.env"] }),
    ],
    unreadable: [],
  });
  const key = backingOfSecret(p, "us-east-1").key;
  const s = sharingOf(key, index, { env: "staging", service: "api" });
  assert.deepEqual(s.others.map((c) => `${c.env}/${c.service}`), ["staging/worker", "production/api"]);
  assert.deepEqual([s.protected, s.self, s.unknown], [true, false, false]);
  const f = sharingOf(backingOfFile("arn:aws:s3:::acme-config/shared.env").key, index, { env: "staging", service: "api" });
  assert.deepEqual([f.protected, f.self], [true, true]);
  assert.deepEqual(sharingOf("ssm:us-east-1/acme/other", index, { env: "staging", service: "api" }), { others: [], protected: false, self: false, unknown: false });

  // Unreadable: a staging service that isn't the console can't raise anyone's protection; a protected one can.
  const quiet = buildRefIndex({ services: [consumer("staging", "api", { secrets: [p] }), consumer("staging", "jobs", { unreadable: true })], unreadable: [{ what: "staging/reports", protected: false }] });
  assert.equal(sharingOf(key, quiet, { env: "staging", service: "api" }).protected, false);
  const loud = buildRefIndex({ services: [consumer("staging", "api", { secrets: [p] }), consumer("production", "jobs", { protected: true, unreadable: true })], unreadable: [] });
  assert.deepEqual(loud.unknown, ["production/jobs"]);
  assert.deepEqual(sharingOf(key, loud, { env: "staging", service: "api" }).protected, true);
  const region = buildRefIndex({ services: [], unreadable: [{ what: "region eu-west-1: timeout", protected: "unknown" }] });
  assert.equal(sharingOf(key, region, { env: "staging", service: "api" }).protected, true, "a region that didn't answer could hold anything");
});

test("one write per backing object: edits through several containers combine, disagreements are conflicts (R05)", () => {
  const file = "arn:aws:s3:::acme-config/shared.env";
  const sm = "arn:aws:secretsmanager:us-east-1:123456789012:secret:acme/db-AbC123";
  const g = groupEdits(
    [
      { container: "api", name: "JWT", value: "k1", valueFrom: "/acme/jwt" },
      { container: "sidecar", name: "JWT_KEY", value: "k1", valueFrom: "arn:aws:ssm:us-east-1:123456789012:parameter/acme/jwt" },
      { container: "api", name: "DB_USER", value: "app", valueFrom: `${sm}:username::` },
      { container: "api", name: "DB_PASS", value: "pw", valueFrom: `${sm}:password::` },
    ],
    [
      { container: "api", file, set: { A: "new-a" }, remove: [] },
      { container: "sidecar", file, set: { B: "new-b" }, remove: ["OLD"] },
    ],
    "us-east-1",
  );
  assert.deepEqual(g.conflicts, []);
  assert.deepEqual(g.secrets.map((w) => [w.key, w.names]), [
    ["ssm:us-east-1/acme/jwt", ["JWT (api)", "JWT_KEY (sidecar)"]],
    ["secret:us-east-1/acme/db", ["DB_USER (api)", "DB_PASS (api)"]],
  ]);
  const doc = g.secrets[1];
  assert.ok(doc.kind === "secretsmanager" && doc.whole === undefined);
  assert.deepEqual(doc.kind === "secretsmanager" && doc.jsonKeys, { username: "app", password: "pw" });
  assert.deepEqual(g.files, [{ key: "s3:acme-config/shared.env", file, containers: ["api", "sidecar"], set: { A: "new-a", B: "new-b" }, remove: ["OLD"], label: "s3://acme-config/shared.env" }]);
  assert.equal(applyJsonKeys(JSON.stringify({ username: "old", password: "old", port: 5432 }), { username: "app", password: "pw" }), JSON.stringify({ username: "app", password: "pw", port: 5432 }));

  const bad = groupEdits(
    [
      { container: "api", name: "JWT", value: "k1", valueFrom: "/acme/jwt" },
      { container: "sidecar", name: "JWT", value: "k2", valueFrom: "/acme/jwt" },
      { container: "api", name: "DB", value: "{}", valueFrom: sm },
      { container: "sidecar", name: "DB_PASS", value: "pw", valueFrom: `${sm}:password::` },
    ],
    [
      { container: "api", file, set: { A: "1" }, remove: ["B"] },
      { container: "sidecar", file, set: { A: "2" }, remove: [] },
      { container: "worker", file, set: { B: "3" }, remove: [] },
    ],
    "us-east-1",
  );
  assert.deepEqual(bad.conflicts, [
    "JWT (api) and JWT (sidecar) set SSM parameter /acme/jwt to different values",
    'DB_PASS (sidecar) changes key "password" of secret acme/db while DB (api) replaces the whole secret',
    "s3://acme-config/shared.env: api and sidecar set A to different values",
    "s3://acme-config/shared.env: B is removed by api and set by worker",
  ]);
});

test("plans: a shared file's edits are listed once, as changes of the file", () => {
  const file = "arn:aws:s3:::acme-config/shared.env";
  const current = [
    { container: "api", name: "A", source: "file" as const, file },
    { container: "sidecar", name: "A", source: "file" as const, file },
  ];
  assert.deepEqual(summarize({ plain: [], secrets: [], files: [{ container: "api, sidecar", file, set: { A: "1", B: "2" }, remove: [] }] }, current), [
    { source: "file", where: file, added: ["B"], changed: ["A"], removed: [] },
  ]);
});

// ---------- the real save runner, reveal and fingerprints ----------
// server/envvars.ts imports "server-only", which only resolves under the react-server condition, so the scenario runs in
// a child process: the simulated account with a few services rewired to share an SSM parameter, a JSON secret and an
// env file, and a backing store that keeps S3-style ETags and secret versions (and can change behind the console's back).
const scenario = String.raw`
const at = (f) => new URL(f, ${JSON.stringify(new URL("./server/", import.meta.url).href)}).href;
const { mockCloud } = await import(at("mock.ts"));
const { HttpError } = await import(at("errors.ts"));
const { parseSecretRef } = await import(at("../envvars.ts"));
const base = mockCloud();
const FILE = "arn:aws:s3:::acme-config/shared.env";
const PARAM = "/acme/shared/JWT_SIGNING_KEY";
const SM = "arn:aws:secretsmanager:us-east-1:123456789012:secret:acme/shared/db-AbC123";
const SELFP = "/acme/console/DATABASE_URL";
const OPSP = "/acme/ops/CONSOLE_TOKEN";
const OPS_TD = "arn:aws:ecs:us-east-1:123456789012:task-definition/deployment-console-ops:7";
const CADDY = (await base.services("acme-staging")).find((s) => s.name === "caddy").taskDef.arn;
const td = (svc, env, rev = 123) => "arn:aws:ecs:us-east-1:123456789012:task-definition/" + svc + "-" + env + ":" + rev;
const S = {
  files: new Map([[FILE, { text: "A=old-a\nB=old-b\n", v: 1 }]]),
  secrets: new Map([[PARAM, { value: "old-jwt", v: 1 }], [SM, { value: JSON.stringify({ username: "app", password: "old-pw", port: 5432 }), v: 1 }], [SELFP, { value: "postgres://console", v: 1 }], [OPSP, { value: "ops-token", v: 1 }]]),
  writes: [], hooks: {}, prodDown: false, req: 0,
};
const ctr = (container, o = {}) => ({ container, environment: o.environment ?? [], secrets: o.secrets ?? [], files: o.files ?? [] });
const CONTAINERS = {
  [td("api", "staging")]: [
    ctr("api", { environment: [{ name: "NODE_ENV", value: "staging" }, { name: "LOG_LEVEL", value: "info" }], files: [FILE],
      secrets: [{ name: "JWT_SIGNING_KEY", valueFrom: PARAM }, { name: "DB_USER", valueFrom: SM + ":username::" }, { name: "DB_PASS", valueFrom: SM + ":password::" }] }),
    ctr("sidecar", { files: [FILE] }),
  ],
  [td("worker", "staging")]: [ctr("worker", { secrets: [{ name: "JWT_SIGNING_KEY", valueFrom: "arn:aws:ssm:us-east-1:123456789012:parameter" + PARAM }] })],
  [td("billing", "staging")]: [ctr("billing", { secrets: [{ name: "CONSOLE_DB", valueFrom: SELFP }] })],
  [td("api", "production")]: [ctr("api", { environment: [{ name: "NODE_ENV", value: "production" }, { name: "LOG_LEVEL", value: "info" }], secrets: [{ name: "JWT_SIGNING_KEY", valueFrom: PARAM }] })],
  [td("deployment-console", "production")]: [ctr("deployment-console", { secrets: [{ name: "DATABASE_URL", valueFrom: SELFP }] })],
  [CADDY]: [ctr("caddy", { secrets: [{ name: "OPS_TOKEN", valueFrom: OPSP }] })],
  [OPS_TD]: [ctr("deployment-console", { secrets: [{ name: "CONSOLE_TOKEN", valueFrom: OPSP }] })],
};
// The console's own cluster when it is no environment (CONSOLE_SELF names it, discovery never lists it).
const OPS = [{ name: "deployment-console", cluster: "acme-ops", status: "ACTIVE", taskDef: { arn: OPS_TD, family: "deployment-console-ops" }, deployments: [], tags: {} }];
const keyOf = (vf) => { const r = parseSecretRef(vf); return r.kind === "ssm" ? r.name : r.secretId; };
globalThis.__consoleCloud = Promise.resolve({
  ...base,
  services: async (cluster) => {
    if (cluster === "acme-production" && S.prodDown) throw new Error("ThrottlingException: Rate exceeded");
    return cluster === "acme-ops" ? OPS : base.services(cluster);
  },
  containerEnv: async (arn) => CONTAINERS[arn] ?? [ctr("main")],
  readEnvFile: async (arn) => { const f = S.files.get(arn); const r = { text: f.text, etag: '"' + f.v + '"' }; await S.hooks.afterFileRead?.(arn); return r; },
  writeEnvFile: async (arn, text, o) => {
    const f = S.files.get(arn);
    if (o?.ifMatch !== undefined && o.ifMatch !== '"' + f.v + '"') throw new HttpError(409, "env file changed since it was read");
    S.writes.push("file " + arn); S.files.set(arn, { text, v: f.v + 1 });
  },
  secretVersion: async (vf) => String(S.secrets.get(keyOf(vf)).v),
  readSecret: async (vf) => {
    const r = parseSecretRef(vf); const v = S.secrets.get(keyOf(vf)).value;
    return r.kind === "secretsmanager" && r.jsonKey ? String(JSON.parse(v)[r.jsonKey]) : v;
  },
  writeSecret: async (vf, value, o) => {
    await S.hooks.beforeSecretWrite?.(vf);
    const cur = S.secrets.get(keyOf(vf));
    if (o?.ifVersion !== undefined && o.ifVersion !== String(cur.v)) throw new HttpError(409, "secret changed since it was read");
    if (parseSecretRef(vf).kind === "secretsmanager" && parseSecretRef(vf).jsonKey) throw new Error("a JSON key write — expected one whole-document write");
    S.writes.push("secret " + keyOf(vf)); S.secrets.set(keyOf(vf), { value, v: cur.v + 1 });
  },
  registerWithEnv: async (arn) => arn.replace(/:\d+$/, ":124"),
  updateService: async () => "req-" + ++S.req,
});
const { listVars, revealVars, saveVars, varFingerprints } = await import(at("envvars.ts"));
const { coordinator } = await import(at("mutations.ts"));
const { keysForInventory } = await import(at("../mutation-keys.ts"));
const { readAudit } = await import(at("audit.ts"));
const { getDb } = await import(at("db.ts"));
const { invalidate } = await import(at("cache.ts"));
const { noteDenied, noteAllowed } = await import(at("capability.ts"));
const admin = { id: "u-admin", email: "admin@acme.example", role: "admin" };
const op = { id: "u-op", email: "op@acme.example", role: "operator" };
const dev = { id: "u-dev", email: "dev@acme.example", role: "developer" };
const API = td("api", "staging"), WORKER = td("worker", "staging"), BILLING = td("billing", "staging");
const run = (p) => p.then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, status: e.status, error: e.message }));
const out = {};

// R05: two containers, one env file, A and B edited → one write with both.
out.r05 = await run(saveVars("staging", "api", { revision: API, confirm: "yes", changes: { files: [{ container: "api", file: FILE, set: { A: "new-a" } }, { container: "sidecar", file: FILE, set: { B: "new-b" } }] } }, admin));
out.r05.file = S.files.get(FILE).text; out.r05.writes = S.writes.splice(0);
out.r05conflict = await run(saveVars("staging", "api", { revision: API, confirm: "yes", changes: { files: [{ container: "api", file: FILE, set: { A: "1" } }, { container: "sidecar", file: FILE, set: { A: "2" } }] } }, admin));
out.r05conflict.writes = S.writes.splice(0);

// The env file changed between the console's read and its write: refused, the other change kept.
S.hooks.afterFileRead = async (arn) => { S.hooks.afterFileRead = undefined; S.files.set(arn, { text: "A=someone-else\n", v: S.files.get(arn).v + 1 }); };
out.etag = await run(saveVars("staging", "api", { revision: API, confirm: "yes", changes: { files: [{ container: "api", file: FILE, set: { A: "mine" } }] } }, admin));
out.etag.file = S.files.get(FILE).text; out.etag.writes = S.writes.splice(0);

// R02: the parameter staging/api and staging/worker read is also read by production/api (protected).
out.list = await listVars("staging", "api", dev);
out.r02dev = await run(saveVars("staging", "api", { revision: API, confirm: "yes", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "dev-wrote-this" }] } }, dev));
out.r02yes = await run(saveVars("staging", "api", { revision: API, confirm: "yes", reason: "rotate", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "x" }] } }, op));
out.r02noReason = await run(saveVars("staging", "api", { revision: API, confirm: "api", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "x" }] } }, op));
out.r02op = await run(saveVars("staging", "api", { revision: API, confirm: "api", reason: "rotate the shared key", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "rotated" }] } }, op));
out.r02op.value = S.secrets.get(PARAM).value; out.r02op.writes = S.writes.splice(0);
out.plainDev = await run(saveVars("staging", "api", { revision: API, confirm: "yes", changes: { plain: [{ container: "api", set: { LOG_LEVEL: "debug" }, remove: [] }] } }, dev));

// The parameter changed behind the console's back between its version read and its write.
S.hooks.beforeSecretWrite = async (vf) => { S.hooks.beforeSecretWrite = undefined; const c = S.secrets.get(keyOf(vf)); S.secrets.set(keyOf(vf), { value: "outside", v: c.v + 1 }); };
out.version = await run(saveVars("staging", "api", { revision: API, confirm: "api", reason: "rotate again", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "mine" }] } }, op));
out.version.value = S.secrets.get(PARAM).value;

// Two keys of one JSON secret in one save → one whole-document write.
out.json = await run(saveVars("staging", "api", { revision: API, confirm: "yes", changes: { secrets: [{ container: "api", name: "DB_USER", value: "svc" }, { container: "api", name: "DB_PASS", value: "new-pw" }] } }, admin));
out.json.doc = JSON.parse(S.secrets.get(SM).value); out.json.writes = S.writes.splice(0);

// A reference the console's own service reads: refused for everyone.
out.self = await run(saveVars("staging", "billing", { revision: BILLING, confirm: "yes", changes: { secrets: [{ container: "billing", name: "CONSOLE_DB", value: "x" }] } }, admin));
out.selfReveal = (await revealVars("staging", "billing", admin)).values.map((v) => [v.name, v.value ?? null, v.error ?? null]);

// One backing object, two services: while staging/worker's save holds the parameter, staging/api can't change it, and
// nothing else can change staging/worker's ECS service (the map's inventory key lands on the same lock, REVIEW R04).
let reached, release; const atWrite = new Promise((r) => (reached = r)); const gate = new Promise((r) => (release = r));
S.hooks.beforeSecretWrite = async () => { S.hooks.beforeSecretWrite = undefined; reached(); await gate; };
const first = run(saveVars("staging", "worker", { revision: WORKER, confirm: "worker", reason: "rotate", changes: { secrets: [{ container: "worker", name: "JWT_SIGNING_KEY", value: "from-worker" }] } }, op));
await atWrite;
out.busySecret = await run(saveVars("staging", "api", { revision: API, confirm: "api", reason: "rotate", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "from-api" }] } }, op));
out.busyMap = await run(coordinator.mutate({ action: "ecs-image.deploy-image", actor: { display: "map@acme.example", kind: "person" }, target: "worker", keys: keysForInventory("ecs:service/acme-staging/worker", "us-east-1", "us-east-1"), params: {} }, async (h) => { await h.intent(); return 1; }));
release();
out.first = await first;
out.first.value = S.secrets.get(PARAM).value;

// Reveal: values the developer may see, the shared-with-production one withheld; audited by name.
out.reveal = (await revealVars("staging", "api", dev, "198.51.100.7")).values.map((v) => [v.container, v.name, v.value ?? null, v.error ?? null]);
out.audit = (await readAudit(50)).filter((a) => a.action === "env.reveal").map((a) => [a.phase, a.user, a.ip ?? null, JSON.stringify(a.params ?? {})]);
out.operations = await (await getDb()).all("SELECT action, state, targets FROM operations ORDER BY created_at");

// Fingerprints: equality only, never values; the console's own service refused.
out.fpStaging = await varFingerprints("staging", "api");
out.fpProd = await varFingerprints("production", "api");
out.fpSelf = await run(varFingerprints("production", "deployment-console"));

// An "act" token (a direct run, no person) can't reach production's value through staging; an approved request can.
const viaToken = { ...op, email: 'op@acme.example via token "release-bot"' };
out.token = await run(saveVars("staging", "api", { revision: API, confirm: "api", reason: "rotate", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "via-token" }] } }, viaToken));
out.tokenPlain = await run(saveVars("staging", "api", { revision: API, confirm: "yes", changes: { plain: [{ container: "api", set: { LOG_LEVEL: "warn" }, remove: [] }] } }, viaToken));
out.tokenApproved = await run(saveVars("staging", "api", { revision: API, confirm: "api", reason: "rotate", changes: { secrets: [{ container: "api", name: "JWT_SIGNING_KEY", value: "approved" }] } }, { ...op, email: 'admin@acme.example approving token "release-bot"' }));
out.tokenApproved.value = S.secrets.get(PARAM).value;

// The console runs in a cluster discovery doesn't list (acme-ops): a parameter it shares with staging/caddy is still its own.
out.opsBefore = (await listVars("staging", "caddy", admin)).vars.find((v) => v.name === "OPS_TOKEN");
process.env.CONSOLE_SELF = "acme-ops/deployment-console-ops"; invalidate("vars:refs");
out.opsList = (await listVars("staging", "caddy", admin)).vars.find((v) => v.name === "OPS_TOKEN");
out.opsSave = await run(saveVars("staging", "caddy", { revision: CADDY, confirm: "yes", changes: { secrets: [{ container: "caddy", name: "OPS_TOKEN", value: "x" }] } }, admin));
out.opsSave.value = S.secrets.get(OPSP).value;
out.opsReveal = (await revealVars("staging", "caddy", admin)).values.find((v) => v.name === "OPS_TOKEN");
out.opsFp = (await varFingerprints("staging", "caddy")).find((v) => v.name === "OPS_TOKEN");
delete process.env.CONSOLE_SELF; invalidate("vars:refs");

// F06: the console's AWS identity was refused ecs:UpdateService.
noteDenied("ecs:UpdateService");
out.capDenied = await listVars("staging", "worker", op);
noteAllowed("ecs:UpdateService");

// Discovery failed for the protected environment: every reference counts as protected.
S.prodDown = true; invalidate("svc:"); invalidate("vars:refs");
out.unknown = await listVars("staging", "worker", dev);
out.unknownSave = await run(saveVars("staging", "worker", { revision: WORKER, confirm: "yes", changes: { secrets: [{ container: "worker", name: "JWT_SIGNING_KEY", value: "x" }] } }, dev));
console.log(JSON.stringify(out));
`;

interface Res { ok: boolean; status?: number; error?: string; [k: string]: unknown }
const runScenario = () => {
  const stdout = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
    encoding: "utf8",
    env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", DATABASE_URL: "", CONSOLE_SECRET_KEY: "test-secret-key-0123456789abcdef0123456789", CONSOLE_REGIONS: "", CONSOLE_SELF: "", ECS_CONTAINER_METADATA_URI_V4: "" },
    timeout: 120_000,
  });
  return JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, Res & Record<string, unknown>>;
};
const o = runScenario();
const vars = (x: unknown) => (x as { vars: { container: string; name: string; source: string; sharedWith?: { env: string; service: string; protected: boolean; self?: true }[]; lockedWhy?: string }[] }).vars;

test("R05 through the real save runner: two containers edit one env file → one write holding both edits", () => {
  assert.equal(o.r05.ok, true, String(o.r05.error));
  assert.equal(o.r05.file, "A=new-a\nB=new-b\n");
  assert.deepEqual(o.r05.writes, ["file arn:aws:s3:::acme-config/shared.env"]);
  assert.deepEqual(o.r05.plan, [{ source: "file", where: "arn:aws:s3:::acme-config/shared.env", added: [], changed: ["A", "B"], removed: [] }]);
  assert.deepEqual([o.r05conflict.ok, o.r05conflict.status, o.r05conflict.writes], [false, 409, []]);
  assert.match(String(o.r05conflict.error), /api and sidecar set A to different values/);
});

test("a backing object that changed between read and write is refused, never overwritten", () => {
  assert.deepEqual([o.etag.ok, o.etag.status, o.etag.writes, o.etag.file], [false, 409, [], "A=someone-else\n"]);
  assert.match(String(o.etag.error), /env file changed since it was read/);
  assert.deepEqual([o.version.ok, o.version.status, o.version.value], [false, 409, "outside"]);
  assert.match(String(o.version.error), /secret changed since it was read/);
});

test("R02 through the real save runner: a reference production also reads follows production's rules", () => {
  assert.deepEqual([o.r02dev.ok, o.r02dev.status], [false, 403]);
  assert.match(String(o.r02dev.error), /\/acme\/shared\/JWT_SIGNING_KEY: shared with production\/api \(protected\) — needs operator role/);
  assert.deepEqual([o.r02yes.status, o.r02noReason.status], [400, 400]);
  assert.match(String(o.r02yes.error), /expected "api"\) — \/acme\/shared\/JWT_SIGNING_KEY is shared with a protected service/);
  assert.match(String(o.r02noReason.error), /a reason is required: this changes a value a protected service reads/);
  assert.equal(o.r02op.ok, true, String(o.r02op.error));
  assert.deepEqual([o.r02op.value, o.r02op.writes, o.r02op.restarted], ["rotated", ["secret /acme/shared/JWT_SIGNING_KEY"], true]);
  assert.deepEqual(o.r02op.alsoUsedBy, ["staging/worker", "production/api"]);
  assert.equal(o.plainDev.ok, true, "plain variables aren't shared: a developer still edits them with a plain confirmation");
});

test("a reference the console's own service reads is never changed or revealed, admins included", () => {
  assert.deepEqual([o.self.ok, o.self.status], [false, 403]);
  assert.match(String(o.self.error), /also used by the console's own service \(production\/deployment-console\)/);
  assert.deepEqual(o.selfReveal, [["CONSOLE_DB", null, "also used by the console's own service (production/deployment-console) — the console never reads or changes its own secrets"]]);
});

test("two keys of one JSON secret are written as one document; the other keys stay", () => {
  assert.equal(o.json.ok, true, String(o.json.error));
  assert.deepEqual(o.json.doc, { username: "svc", password: "new-pw", port: 5432 });
  assert.deepEqual(o.json.writes, ["secret arn:aws:secretsmanager:us-east-1:123456789012:secret:acme/shared/db-AbC123"]);
});

test("a save locks its service and every object it writes: the shared parameter and the map's key for the service (R04)", () => {
  assert.deepEqual([o.busySecret.ok, o.busySecret.status], [false, 409]);
  assert.match(String(o.busySecret.error), /env\.update by op@acme\.example/);
  assert.deepEqual([o.busyMap.ok, o.busyMap.status], [false, 409]);
  assert.equal(o.first.ok, true, String(o.first.error));
  assert.equal(o.first.value, "from-worker");
});

test("the list shows who else reads each reference and what this user may not do with it", () => {
  const v = vars(o.list);
  const jwt = v.find((x) => x.name === "JWT_SIGNING_KEY")!;
  assert.deepEqual(jwt.sharedWith, [{ env: "staging", service: "worker", region: "us-east-1", protected: false }, { env: "production", service: "api", region: "us-east-1", protected: true }]);
  assert.equal(jwt.lockedWhy, "shared with production/api (protected) — needs operator role");
  const fileVar = v.find((x) => x.name === "A" && x.container === "api")!;
  assert.equal(fileVar.sharedWith, undefined, "the sidecar is the same service");
  assert.equal(v.find((x) => x.name === "DB_USER")!.sharedWith, undefined);
  assert.deepEqual([o.list.protected, o.list.envProtected, o.list.canEdit, o.list.canReveal], [true, false, true, true]);
  assert.ok(!JSON.stringify(o.list).includes("old-jwt") && !JSON.stringify(o.list).includes("old-pw"), "names only");
});

test("reveal: allowed values, the shared-with-production one withheld, audited by name before anything is returned", () => {
  const by = Object.fromEntries((o.reveal as unknown as [string, string, string | null, string | null][]).map(([c, n, v, e]) => [`${c} ${n}`, [v, e]]));
  assert.deepEqual(by["api NODE_ENV"], ["staging", null]);
  assert.deepEqual(by["api DB_USER"], ["svc", null]);
  assert.deepEqual(by["api JWT_SIGNING_KEY"], [null, "shared with production/api (protected) — needs operator role"]);
  assert.deepEqual(by["sidecar A"], ["someone-else", null], "the file as the outside change left it");
  const audit = o.audit as unknown as [string, string, string | null, string][];
  const intent = audit.find(([phase, user]) => phase === "intent" && user === "dev@acme.example")!;
  assert.ok(intent, "an intent row for the developer's reveal");
  assert.equal(intent[2], "198.51.100.7");
  const params = JSON.parse(intent[3]) as { names: string[]; withheld: string[] };
  assert.ok(params.names.includes("DB_USER") && !params.names.includes("JWT_SIGNING_KEY") && params.withheld.includes("JWT_SIGNING_KEY"));
  assert.ok(!intent[3].includes("svc") && !intent[3].includes("new-pw"), "names, never values");
});

test("saves and reveals are coordinator operations; refusals leave no operation behind", () => {
  const ops = o.operations as unknown as { action: string; state: string; targets: string }[];
  const updates = ops.filter((x) => x.action === "env.update");
  assert.deepEqual(updates.map((x) => x.state), ["succeeded", "failed", "succeeded", "succeeded", "failed", "succeeded", "succeeded"], "r05, etag, r02op, plainDev, version, json, first");
  const keys = (JSON.parse(updates[2].targets) as { keys: string[] }).keys;
  assert.deepEqual(keys, ["ecs-service:us-east-1/acme-production/api", "ecs-service:us-east-1/acme-staging/api", "ecs-service:us-east-1/acme-staging/worker", "ssm:us-east-1/acme/shared/JWT_SIGNING_KEY"]);
  assert.ok(ops.some((x) => x.action === "env.reveal" && x.state === "succeeded"));
});

test("fingerprints: equal values compare equal across environments, values never appear, the console's own service is refused", () => {
  type Fp = { container: string; name: string; source: string; fingerprint: string | null }[];
  const s = o.fpStaging as unknown as Fp, p = o.fpProd as unknown as Fp;
  const f = (list: Fp, name: string) => list.find((x) => x.container === "api" && x.name === name)!.fingerprint;
  assert.equal(f(s, "LOG_LEVEL"), f(p, "LOG_LEVEL"));
  assert.notEqual(f(s, "NODE_ENV"), f(p, "NODE_ENV"));
  assert.equal(f(s, "JWT_SIGNING_KEY"), f(p, "JWT_SIGNING_KEY"), "one shared parameter");
  assert.match(f(s, "LOG_LEVEL")!, /^[A-Za-z0-9_-]{43}$/);
  const all = JSON.stringify([s, p]);
  for (const secret of ["from-worker", "new-pw", "staging\"", "new-a", "postgres"]) assert.ok(!all.includes(secret), secret);
  assert.deepEqual([o.fpSelf.ok, o.fpSelf.status], [false, 403]);
});

test("an API token acting on its own can't change a value a protected service reads; an approved request can", () => {
  assert.deepEqual([o.token.ok, o.token.status], [false, 403]);
  assert.match(String(o.token.error), /an API token can change it only through an approved request/);
  assert.equal(o.tokenPlain.ok, true, String(o.tokenPlain.error));
  assert.equal(o.tokenApproved.ok, true, String(o.tokenApproved.error));
  assert.equal(o.tokenApproved.value, "approved");
});

test("the console's own service in a cluster that is no environment still owns what it reads", () => {
  const before = o.opsBefore as unknown as { sharedWith?: unknown; lockedWhy?: string };
  assert.equal(before.sharedWith, undefined, "without CONSOLE_SELF nobody else reads it");
  const list = o.opsList as unknown as { sharedWith?: { env: string; service: string; protected: boolean; self?: true }[]; lockedWhy?: string };
  assert.deepEqual(list.sharedWith, [{ env: "acme-ops", service: "deployment-console", region: "us-east-1", protected: true, self: true }]);
  assert.match(String(list.lockedWhy), /console's own service \(acme-ops\/deployment-console\)/);
  assert.deepEqual([o.opsSave.ok, o.opsSave.status, o.opsSave.value], [false, 403, "ops-token"]);
  const rev = o.opsReveal as unknown as { value?: string; error?: string };
  assert.equal(rev.value, undefined);
  assert.match(String(rev.error), /console's own service/);
  assert.equal((o.opsFp as unknown as { fingerprint: string | null }).fingerprint, null);
});

test("F06: the console's own AWS permissions decide whether editing is offered", () => {
  assert.deepEqual([o.capDenied.canEdit, o.capDenied.capability], [false, "denied"]);
  assert.match(String(o.capDenied.editWhy), /ecs:UpdateService/);
});

test("discovery failure for a protected environment: every shared-reference check fails closed", () => {
  assert.match(String(o.unknown.sharingUnknown), /couldn't check which other services use it/);
  assert.equal(o.unknown.protected, true);
  assert.match(String(vars(o.unknown).find((x) => x.name === "JWT_SIGNING_KEY")!.lockedWhy), /needs operator role/);
  assert.deepEqual([o.unknownSave.ok, o.unknownSave.status], [false, 403]);
});
