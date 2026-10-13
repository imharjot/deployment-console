// Rules for map actions (pure), and the real runner (src/lib/server/inventory-actions.ts) end to end against the
// simulated account: R04 (one lock across the map, console actions and variable saves — REVIEW's race reproduction),
// R01 (protection read live before a change), R08 (no bearer URL in the audit log or the operation record) and F06
// (a known refusal stops the action first). Server modules import "server-only", so those scenarios run in a child
// process with the react-server condition and an in-memory console DB; this test only reads their JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalKey } from "../mutation-keys.ts";
import { actionKeys, auditSummaryOf, capabilityText, iamOf, isSelfTagged, protectionOf, recheck, SELF, TAGS_UNREAD } from "./action-rules.ts";

const SIGNED = "https://acme-assets.s3.us-east-1.amazonaws.com/reports/q3.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261005%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261005T120000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=0123456789abcdef";

test("protection: tags not read fail closed; hints, environments, the tag and unassigned resources protect", () => {
  const envs = [{ id: "staging", protected: false }, { id: "production", protected: true }];
  const r = (o: Record<string, unknown> = {}) => ({ tags: {}, env: "staging", ...o });
  assert.deepEqual(protectionOf(r(), envs), { protected: false });
  assert.deepEqual(protectionOf(r({ tagsUnread: true }), envs), { protected: true, why: TAGS_UNREAD });
  assert.deepEqual(protectionOf(r({ tags: { "console:protected": "true" } }), envs), { protected: true, why: "tag console:protected" });
  assert.equal(protectionOf(r({ env: "production" }), envs).protected, true);
  assert.equal(protectionOf(r({ protectedBy: "connected to production/api" }), envs).why, "connected to production/api");
  assert.equal(protectionOf(r({ env: undefined }), envs).protected, true, "unassigned → careful rules");
  assert.equal(protectionOf(r({ env: undefined }), envs, false).protected, false, "inventory.unassignedProtected: false");
  assert.deepEqual([isSelfTagged({ "console:self": "true" }), isSelfTagged({ "console:self": " TRUE " }), isSelfTagged({}), isSelfTagged(undefined)], [true, true, false, false]);
});

test("recheck after the live read: self refuses; newly protected needs the role, then the name and a reason", () => {
  const base = { name: "orders", was: false, self: false, allowedProtected: true, needs: "operator", role: "developer" };
  assert.equal(recheck({ ...base, now: { protected: false } }), undefined);
  assert.deepEqual(recheck({ ...base, self: true, now: { protected: false } }), { status: 409, error: SELF });
  assert.equal(recheck({ ...base, now: { protected: true, why: "tag console:protected" }, allowedProtected: false })?.status, 403);
  const again = recheck({ ...base, now: { protected: true, why: "tag console:protected" }, confirm: "yes" });
  assert.equal(again?.status, 409);
  assert.match(again!.error, /orders is protected \(tag console:protected\) — run the dry run again/);
  assert.equal(recheck({ ...base, now: { protected: true }, confirm: "orders", reason: "rotate" }), undefined, "already confirmed like a protected change");
  assert.equal(recheck({ ...base, was: true, now: { protected: true } }), undefined, "was protected: the caller already met those rules");
});

test("R04: a map key and the environment/service pair lock the same canonical key; extra targets are added", () => {
  const svc = canonicalKey({ ecsService: { region: "us-east-1", cluster: "acme-staging", service: "api" } });
  assert.deepEqual(actionKeys("ecs:service/acme-staging/api", undefined, "us-east-1", "us-east-1"), [svc]);
  assert.deepEqual(actionKeys("ecs:service/acme-production/api@eu-west-1", undefined, "eu-west-1", "us-east-1"), ["ecs-service:eu-west-1/acme-production/api"]);
  const fn = "arn:aws:lambda:us-east-1:123456789012:function:orders";
  assert.deepEqual(actionKeys(`${fn}:live`, [fn, "", "ecs:service/acme-staging/api"], "us-east-1", "us-east-1"), [fn, svc].sort(), "an alias locks its function; blanks are ignored");
});

test("R08: the audit summary of a fake S3 download has no URL and no X-Amz-Signature", () => {
  const result = { bucket: "acme-assets", key: "reports/q3.csv", url: SIGNED, expiresAt: Date.UTC(2026, 9, 5, 12, 5), requestId: "R1" };
  const input = { key: "reports/q3.csv" };
  for (const summary of [
    auditSummaryOf({}, result, input), // no auditSummary: ids, versions and sizes only
    auditSummaryOf({ auditSummary: (r: unknown) => ({ ...(r as object) }) }, result, input), // a careless auditSummary is still scrubbed
    auditSummaryOf({ auditSummary: () => ({ link: `see ${SIGNED}`, nested: { u: SIGNED } }) }, result, input),
    auditSummaryOf({ auditSummary: () => { throw new Error("boom"); } }, result, input), // a throwing one falls back to the safe default
  ]) {
    const text = JSON.stringify(summary);
    assert.ok(!/X-Amz-Signature/i.test(text), text);
    assert.ok(!/https?:\/\//i.test(text), text);
  }
  assert.deepEqual(auditSummaryOf({ auditSummary: (_r: unknown, i: { key: string }) => ({ bucket: "acme-assets", key: i.key, expiresInSeconds: 300 }) }, result, input), { bucket: "acme-assets", key: "reports/q3.csv", expiresInSeconds: 300 });
  assert.deepEqual(auditSummaryOf({}, result, input), { key: "reports/q3.csv", requestId: "R1" }, "the coordinator's default: ids, versions and sizes");
  assert.deepEqual(auditSummaryOf({}, { password: "hunter2", version: 3 }, {}), { version: 3 });
});

test("F06: capability text and the IAM actions an action needs", () => {
  assert.deepEqual(capabilityText({ state: "denied", missing: ["lambda:PublishVersion"] }), { blocked: "The console's AWS identity lacks lambda:PublishVersion — see Settings → AWS permissions" });
  assert.deepEqual(capabilityText({ state: "probably-denied", missing: ["sqs:PurgeQueue"] }), { note: "AWS permission not verified — likely denied (sqs:PurgeQueue)" });
  assert.deepEqual(capabilityText({ state: "allowed", missing: [] }), {});
  assert.deepEqual(capabilityText({ state: "unknown", missing: [] }), {});
  assert.deepEqual(iamOf({ iam: ["lambda:UpdateFunctionCode", "lambda:UpdateFunctionCode"] }, { write: ["x:Y"], actions: [1, 2] }), ["lambda:UpdateFunctionCode"]);
  assert.deepEqual(iamOf({}, { write: ["cloudfront:CreateInvalidation"], actions: [1] }), ["cloudfront:CreateInvalidation"], "a provider's only action needs its write list");
  assert.deepEqual(iamOf({}, { write: ["ec2:StartInstances", "ec2:StopInstances"], actions: [1, 2] }), [], "several actions: unknown which");
  assert.deepEqual(iamOf({}, { write: ["cloudflare:Cache Purge"], actions: [1] }), [], "token scopes aren't IAM");
});

// ---------- the real runner, in a child process ----------

const root = fileURLToPath(new URL("../../../", import.meta.url));

function inChild<T>(body: string): T {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-actions-"));
  try {
    const base = new URL("../server/", import.meta.url).href;
    const code = `const mod = (p) => import(new URL(p, ${JSON.stringify(base)}).href); const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out), () => process.exit(0));`;
    const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_DATA_DIR: dir, CONSOLE_SQLITE_PATH: ":memory:", DATABASE_URL: "", CONSOLE_CONFIG: "", CONSOLE_REGIONS: "", AUTH_MODE: "dev", NODE_ENV: "test" },
    });
    assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
    return JSON.parse(r.stdout) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// REVIEW evidence deployment-console-race-review.mjs, through the real runners: a map deploy paused while it
// registers its task definition; meanwhile a variable save (and any other change) to the same ECS service must be
// refused (409), so the deploy can't silently revert the variable edit. Then the other way round.
test("R04 (REVIEW race): a map deploy in flight refuses a variable save and a restart of the same service; a change in flight refuses the map deploy", () => {
  const out = inChild<Record<string, unknown>>(`
    const { mockCloud, mockCi } = await mod("mock.ts");
    const { canonicalKey } = await mod("../mutation-keys.ts");
    const c = mockCloud();
    const updates = [];
    let signal; const registering = new Promise((r) => (signal = r));
    let resume; const resumed = new Promise((r) => (resume = r));
    const live = (await c.services("acme-staging")).find((s) => s.name === "api");
    globalThis.__consoleCloud = Promise.resolve({ ...c,
      registerWithImage: async (arn) => { signal(); await resumed; return arn.replace(/:\\d+$/, ":901"); },
      registerWithEnv: async (arn) => arn.replace(/:\\d+$/, ":902"),
      updateService: async (cluster, service, change) => { updates.push(change); return "isolated-mock-request"; },
    });
    globalThis.__consoleCi = Promise.resolve(mockCi());
    const { runAction } = await mod("inventory-actions.ts");
    const { saveVars } = await mod("envvars.ts");
    const { mutate } = await mod("mutations.ts");
    const user = { id: "reviewer", email: "reviewer@example.test", role: "admin" };
    const key = canonicalKey({ ecsService: { region: "us-east-1", cluster: "acme-staging", service: "api" } });
    const image = (tag) => live.taskDef.image.replace(/:[^:]+$/, ":" + tag);
    const out = {};
    const deploy = runAction({ key: "ecs:service/acme-staging/api", provider: "ecs-image", action: "deploy-image", input: { image: image("review") }, confirm: "api", reason: "isolated concurrency check" }, { user, actor: user.email });
    out.first = await Promise.race([registering.then(() => "registering"), deploy.then(() => "finished", (e) => "failed: " + e.message)]);
    if (out.first === "registering") {
      try {
        await saveVars("staging", "api", { revision: live.taskDef.arn, confirm: "yes", changes: { plain: [{ container: live.taskDef.main, set: { REVIEW: "new" } }] } }, user, undefined);
        out.vars = 200;
      } catch (e) { out.vars = e.status ?? 500; out.varsError = e.message; }
      try {
        await mutate({ action: "services.restart", actor: { display: "someone@example.test", kind: "person" }, target: "api", keys: [key], params: {} }, async (h) => { await h.intent(); return "x"; });
        out.restart = 200;
      } catch (e) { out.restart = e.status ?? 500; out.restartError = e.message; }
      resume();
    }
    try { const r = await deploy; out.deploy = { operationId: typeof r.operationId === "string", taskDefinition: r.result?.taskDefinition }; } catch (e) { out.deploy = { error: e.message }; }
    out.updates = updates.length;

    // The other way round: a change holding the service (as a variable save or a restart does) refuses the map deploy.
    let release; const held = new Promise((r) => (release = r));
    let entered; const inBody = new Promise((r) => (entered = r));
    const hold = mutate({ action: "vars.edit", actor: { display: "someone@example.test", kind: "person" }, target: "api", keys: [key], params: {} }, async (h) => { entered(); await held; await h.intent(); return 1; });
    await inBody;
    try {
      await runAction({ key: "ecs:service/acme-staging/api", provider: "ecs-image", action: "deploy-image", input: { image: image("review2") }, confirm: "api", reason: "second deploy" }, { user, actor: user.email });
      out.reverse = 200;
    } catch (e) { out.reverse = e.status ?? 500; out.reverseError = e.message; }
    release();
    await hold;
    out.updatesAfter = updates.length;
    return out;
  `);
  assert.equal(out.first, "registering", JSON.stringify(out));
  assert.equal(out.restart, 409, `a restart of the same service must be refused: ${out.restartError ?? ""}`);
  assert.equal(out.vars, 409, `a variable save of the same service must be refused while the map deploy runs: ${out.varsError ?? "it was accepted"}`);
  assert.match(String(out.varsError), /in progress \(ecs-image\.deploy-image by reviewer@example\.test\)/, "refused by the coordinator, naming the deploy");
  assert.match(String(out.restartError), /in progress \(ecs-image\.deploy-image by reviewer@example\.test\)/);
  assert.deepEqual(out.deploy, { operationId: true, taskDefinition: (out.deploy as { taskDefinition?: string })?.taskDefinition }, JSON.stringify(out.deploy));
  assert.match(String((out.deploy as { taskDefinition?: string }).taskDefinition), /:901$/);
  assert.equal(out.updates, 1, "only the deploy changed the service");
  assert.equal(out.reverse, 409, String(out.reverseError));
  assert.match(String(out.reverseError), /another change to .* is in progress \(vars\.edit by someone@example\.test\)/);
  assert.equal(out.updatesAfter, 1);
});

test("R01, R08, F06 through the real runner: live protection decides; refusals before anything is recorded; no bearer URL is stored", () => {
  const out = inChild<Record<string, unknown>>(`
    const { providerById } = await mod("providers/index.ts");
    const { runAction, listActions } = await mod("inventory-actions.ts");
    const { getInventory } = await mod("inventory.ts");
    const { noteDenied, noteAllowed } = await mod("capability.ts");
    const { getDb } = await mod("db.ts");
    const admin = { id: "a", email: "admin@example.test", role: "admin" };
    const dev = { id: "d", email: "dev@example.test", role: "developer" };
    const v = await getInventory();
    const fn = v.resources.find((r) => r.kind === "lambda" && r.env === "staging");
    const lambda = providerById("lambda");
    const action = { key: fn.key, provider: "lambda", action: "publish-version", input: {} };
    const run = async (user, extra = {}) => {
      try { const r = await runAction({ ...action, confirm: "yes", ...extra }, { user, actor: user.email }); return { status: 202, operationId: r.operationId }; }
      catch (e) { return { status: e.status ?? 500, error: e.message }; }
    };
    const db = await getDb();
    const rows = async () => (await db.get("SELECT COUNT(*) AS n FROM operations")).n;
    const out = { fn: fn.key, protectedInMap: false };

    // No live read: the fallback re-reads the provider; tags it couldn't read refuse the change.
    const ownRead = lambda.authoritative;
    delete lambda.authoritative;
    const discover = lambda.discover;
    lambda.discover = async (ctx) => { const r = await discover.call(lambda, ctx); return { ...r, resources: r.resources.map((x) => (x.key === fn.key ? { ...x, tagsUnread: true } : x)) }; };
    const before = await rows();
    out.unread = await run(dev);
    out.unreadRecorded = (await rows()) - before;
    lambda.discover = discover;
    out.reread = await run(dev);

    // A live read that fails refuses; one that finds console:protected needs the role, then the name and a reason.
    lambda.authoritative = async () => { throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }); };
    out.failing = await run(dev);
    lambda.authoritative = async () => ({ tags: { "console:protected": "true" } });
    out.protectedDev = await run(dev);
    out.protectedAdminYes = await run(admin);
    out.protectedAdminName = await run(admin, { confirm: fn.name, reason: "release 42" });
    lambda.authoritative = async () => ({ tags: { "console:self": "true" } });
    out.self = await run(admin);
    lambda.authoritative = async () => ({ tags: Object.assign(Object.create({ "console:protected": "true" }), { team: "media" }) });
    out.inherited = await run(dev); // only own properties count: an inherited tag is not a tag
    // The provider's own live read (simulated tags in the demo).
    if (ownRead) lambda.authoritative = ownRead;
    out.ownRead = ownRead ? await run(dev) : { status: 202 };

    // F06: a refusal AWS gave recently blocks the action before anything else, and the listing says why.
    const act = lambda.actions.find((a) => a.id === "publish-version");
    const iam = act.iam;
    act.iam = ["lambda:PublishVersion"];
    noteDenied("lambda:PublishVersion");
    out.denied = await run(dev);
    out.listed = (await listActions(fn.key, dev)).find((a) => a.id === "publish-version")?.blocked ?? null;
    noteAllowed("lambda:PublishVersion");
    act.iam = iam;

    // R08: a download hands the person a signed link; neither the audit log nor the operation record keeps it.
    const s3 = providerById("s3");
    const dl = s3.actions.find((a) => a.id === "download-object");
    const bucket = (await getInventory()).resources.find((r) => r.kind === "s3");
    const dlRun = dl.run;
    dl.run = async (r, i) => ({ bucket: r.name, key: i.key, url: ${JSON.stringify(SIGNED)}, expiresAt: Date.now() + 300000 });
    const dlWhen = dl.when;
    dl.when = undefined;
    const body = { key: bucket.key, provider: "s3", action: "download-object", input: { key: "reports/q3.csv" } };
    const plan = await runAction({ ...body, dryRun: true }, { user: admin, actor: admin.email });
    const got = await runAction({ ...body, confirm: plan.plan.confirm, reason: "quarterly report" }, { user: admin, actor: admin.email });
    out.download = { gotUrl: String(got.result?.url ?? "").includes("X-Amz-Signature") };
    const stored = JSON.stringify([await db.all("SELECT * FROM operations WHERE action = 's3.download-object'"), await db.all("SELECT * FROM audit WHERE action = 's3.download-object'")]);
    out.download.storedRows = stored.length > 50;
    out.download.leaks = ["X-Amz-Signature", "X-Amz-Credential", "https://"].filter((s) => stored.includes(s));
    dl.run = dlRun;
    dl.when = dlWhen;
    return out;
  `);
  const o = out as Record<string, { status: number; error?: string }> & { unreadRecorded: number; listed: string | null; download: { gotUrl: boolean; storedRows: boolean; leaks: string[] } };
  assert.equal(o.unread.status, 409, JSON.stringify(o.unread));
  assert.match(o.unread.error!, /protection metadata unavailable — refusing to change .*a fresh read couldn't read its tags/);
  assert.equal(o.unreadRecorded, 0, "refused before the operation row and audit intent");
  assert.equal(o.reread.status, 202, JSON.stringify(o.reread));
  assert.equal(o.failing.status, 409);
  assert.match(o.failing.error!, /protection metadata unavailable .*Rate exceeded/);
  assert.equal(o.protectedDev.status, 403, JSON.stringify(o.protectedDev));
  assert.match(o.protectedDev.error!, /is protected \(tag console:protected\)/);
  assert.equal(o.protectedAdminYes.status, 409);
  assert.match(o.protectedAdminYes.error!, /run the dry run again/);
  assert.equal(o.protectedAdminName.status, 202, JSON.stringify(o.protectedAdminName));
  assert.equal(o.self.status, 409);
  assert.equal(o.self.error, SELF);
  assert.equal(o.inherited.status, 202, JSON.stringify(o.inherited));
  assert.equal(o.ownRead.status, 202, JSON.stringify(o.ownRead));
  assert.equal(o.denied.status, 409);
  assert.match(o.denied.error!, /lacks lambda:PublishVersion — see Settings → AWS permissions/);
  assert.match(String(o.listed), /lacks lambda:PublishVersion/);
  assert.equal(o.download.gotUrl, true, "the person gets the link");
  assert.equal(o.download.storedRows, true);
  assert.deepEqual(o.download.leaks, [], "no signed URL in operations or audit rows");
});
