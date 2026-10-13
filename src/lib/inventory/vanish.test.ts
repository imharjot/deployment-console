import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InventoryCompleteness, Resource } from "./types.ts";
import { contributed, coverageFreshness, etagMatches, etagOf, isSlimRow, knownOf, reconcile, shortHash, slimRow, unresolvedOf, vanishingResource, type RunRead } from "./vanish.ts";

const T = Date.UTC(2026, 9, 5, 14, 2);
const MIN = 60_000;
const res = (key: string, extra: Partial<Resource> = {}): Resource => ({ key, kind: "sqs", provider: "sqs", name: key.split(":").pop()!, region: "us-east-1", tags: {}, health: "ok", props: [{ label: "Type", value: "standard" }], ...extra });
const run = (keys: string[], at: number, complete = true, links: RunRead["links"] = []): RunRead => ({ resources: keys.map((k) => res(k)), links, mentions: [], at, complete });
const keys = (rs: Resource[]) => rs.map((r) => r.key).sort();

test("a resource missing from a complete run stays one more cycle, marked — dropped after the second complete run without it", () => {
  let k = knownOf(run(["q:a", "q:b"], T));
  k = reconcile(k, run(["q:a"], T + 2 * MIN));
  assert.deepEqual(keys(k.resources), ["q:a"]);
  assert.deepEqual(k.vanishing.map((v) => [v.resource.key, v.lastSeen, v.misses]), [["q:b", T, 1]]);
  const shown = contributed(k);
  const b = shown.find((r) => r.key === "q:b")!;
  assert.equal(b.health, "unknown");
  assert.equal(b.healthReason, "not seen since 14:02 UTC — confirming");
  assert.equal(b.facts?.vanishing, true);
  assert.equal(b.props.length, 1, "shown as it was last seen");
  k = reconcile(k, run(["q:a"], T + 4 * MIN));
  assert.deepEqual(k.vanishing, [], "the second consecutive complete run without it confirms the deletion");
  assert.deepEqual(keys(contributed(k)), ["q:a"]);
});

test("denied, partial or capped runs never remove anything, and don't count towards the confirmation", () => {
  let k = knownOf(run(["q:a", "q:b", "q:c"], T, true, [{ from: "q:c", to: "q:a", kind: "event", evidence: "redrive" }]));
  // partial / capped: c wasn't listed — carried with its link, last seen at T
  k = reconcile(k, run(["q:a", "q:b"], T + 2 * MIN, false));
  assert.deepEqual(keys(k.resources), ["q:a", "q:b", "q:c"]);
  assert.equal(k.seenAt.get("q:c"), T);
  assert.equal(k.links.length, 1);
  assert.deepEqual(k.vanishing, []);
  // a complete run without c: now confirming, last seen T (not the partial run's time)
  k = reconcile(k, run(["q:a", "q:b"], T + 4 * MIN));
  assert.deepEqual(k.vanishing.map((v) => [v.resource.key, v.lastSeen]), [["q:c", T]]);
  // an incomplete run in between doesn't advance it…
  k = reconcile(k, run(["q:a"], T + 6 * MIN, false));
  assert.deepEqual(k.vanishing.map((v) => [v.resource.key, v.misses]), [["q:c", 1]]);
  assert.deepEqual(keys(k.resources), ["q:a", "q:b"], "b carried, not vanishing");
  // …the next complete run does
  k = reconcile(k, run(["q:a", "q:b"], T + 8 * MIN));
  assert.deepEqual(k.vanishing, []);
});

test("a resource that comes back is normal again; one another provider still lists is never shown as vanishing", () => {
  let k = knownOf(run(["q:a", "q:b"], T));
  k = reconcile(k, run(["q:a"], T + MIN));
  k = reconcile(k, run(["q:a", "q:b"], T + 2 * MIN));
  assert.deepEqual(k.vanishing, []);
  assert.deepEqual(keys(k.resources), ["q:a", "q:b"]);
  k = reconcile(k, run(["q:a"], T + 3 * MIN));
  assert.deepEqual(keys(contributed(k, new Set(["q:b"]))), ["q:a"], "listed by another run");
  // vanishingResource keeps the owner's facts and marks the copy
  const v = vanishingResource({ resource: res("q:z", { facts: { fifo: true } }), lastSeen: T, misses: 1 });
  assert.deepEqual(v.facts, { fifo: true, vanishing: true, lastSeen: T });
});

test("slim rows: hidden and generic rows lose props (and all but the drawn facts); others are untouched", () => {
  const generic = res("arn:aws:sagemaker:us-east-1:123456789012:endpoint/x", { kind: "aws-resource", resourceType: "sagemaker:endpoint", facts: { remote: true, big: "x".repeat(100) } });
  const hidden = res("arn:aws:iam::123456789012:role/aws-service-role/x", { kind: "iam-role", hidden: true });
  const normal = res("q:a", { facts: { fifo: true } });
  assert.deepEqual([isSlimRow(generic), isSlimRow(hidden), isSlimRow(normal)], [true, true, false]);
  const s = slimRow(generic);
  assert.deepEqual([s.slim, s.props, s.facts], [true, [], { remote: true }]);
  assert.deepEqual(slimRow(hidden).facts, undefined);
  assert.equal(slimRow(normal), normal);
});

test("ETag: weak, per build and phase, compared weakly; a short signature for per-request extras", () => {
  assert.equal(etagOf(1791160100727, false), 'W/"1791160100727"');
  assert.equal(etagOf(1791160100727, true, "abc"), 'W/"1791160100727-partial-abc"');
  const e = etagOf(5, false);
  assert.ok(etagMatches(e, e));
  assert.ok(etagMatches('"5"', e), "W/ ignored");
  assert.ok(etagMatches('W/"4", W/"5"', e));
  assert.ok(etagMatches("*", e));
  assert.ok(!etagMatches('W/"5-partial"', e));
  assert.ok(!etagMatches(null, e) && !etagMatches("", e));
  assert.equal(shortHash("a=1|b=2"), shortHash("a=1|b=2"));
  assert.notEqual(shortHash("a=1|b=2"), shortHash("a=1|b=3"));
});

test("unresolved remote references (R14 nodes), at most 200 listed", () => {
  const remote = (i: number) => res(`arn:aws:rds:eu-west-1:999999999999:db:orders-${i}`, { kind: "aws-resource", source: "reference", region: "eu-west-1", health: "unknown", facts: { remote: true } });
  const u = unresolvedOf([...Array.from({ length: 205 }, (_, i) => remote(i)), res("q:a")]);
  assert.equal(u.total, 205);
  assert.equal(u.list.length, 200);
  assert.deepEqual(u.list[0], { key: "arn:aws:rds:eu-west-1:999999999999:db:orders-0", ref: "arn:aws:rds:eu-west-1:999999999999:db:orders-0", account: "999999999999", region: "eu-west-1" });
  assert.deepEqual(unresolvedOf([res("external:x", { kind: "external", source: "reference", region: "global" })]).list, [{ key: "external:x", ref: "external:x" }]);
});

test("coverage freshness: complete only when the last build was; notes say what is missing", () => {
  const c = (o: Partial<InventoryCompleteness> = {}): InventoryCompleteness => ({ providers: { ok: 20, denied: 0, error: 0, skipped: 0, disabled: 3, partial: 0 }, cappedTypes: [], deniedActions: [], staleProviders: [], unresolvedRefs: 0, enrichmentSkipped: 0, ...o });
  assert.deepEqual(coverageFreshness({ generatedAt: T, completeness: c({ lastCompleteAt: T }) }, 5 * MIN), { observedAt: T, staleAfterMs: 5 * MIN, source: "inventory", completeness: "complete" });
  const f = coverageFreshness({ generatedAt: T, completeness: c({ lastCompleteAt: T - MIN, providers: { ok: 18, denied: 1, error: 1, skipped: 0, disabled: 3, partial: 0 }, cappedTypes: ["lambda:function@us-east-1"] }), pendingRegions: ["eu-west-1"], vanishing: 2 }, 5 * MIN);
  assert.equal(f.completeness, "partial");
  assert.deepEqual(f.notes, ["1 source denied", "1 source failing", "1 type capped", "eu-west-1 still being read", "2 resources pending deletion confirmation"]);
  assert.equal(coverageFreshness({ generatedAt: T }, MIN).completeness, "unknown");
});

// ---------- the inventory server, end to end (simulated account, child process) ----------
// Server modules import "server-only": the scenario runs with the react-server condition and an in-memory console DB.

const root = fileURLToPath(new URL("../../../", import.meta.url));

function inChild<T>(body: string): T {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-vanish-"));
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

test("inventory server: deletions are confirmed over two complete runs, incomplete and refused runs remove nothing, security groups are read once (CC-19), ETag per build", () => {
  const out = inChild<Record<string, unknown>>(`
    const inv = await mod("inventory.ts");
    const { providerById } = await mod("providers/index.ts");
    const { getCloud } = await mod("sources.ts");
    const out = {};
    let first = await inv.getInventory();
    for (let i = 0; i < 40 && first.partial?.pendingRegions?.length; i++) { await new Promise((r) => setTimeout(r, 250)); first = await inv.getInventory(); }
    const old = "arn:aws:sqs:us-east-1:123456789012:acme-exports-old";
    const sqs = providerById("sqs");
    const discover = sqs.discover;
    const without = (extra) => async (ctx) => { const r = await discover.call(sqs, ctx); extra?.(ctx); return { ...r, resources: r.resources.filter((x) => x.key !== old) }; };
    const look = async () => { const v = await inv.getInventory(); const q = v.resources.find((r) => r.key === old); return q ? { health: q.health, reason: q.healthReason ?? null, vanishing: q.facts?.vanishing ?? false } : null; };
    out.before = await look();

    // A capped run (it says it stopped early) that doesn't list the queue: kept as it was.
    sqs.discover = without((ctx) => ctx.note("sqs: showing the first 4 queues"));
    inv.invalidateProvider("sqs");
    out.capped = await look();
    // A refused run: everything it listed before stays (with the time), nothing is removed.
    sqs.discover = async () => { throw Object.assign(new Error("User: x is not authorized to perform: sqs:ListQueues"), { name: "AccessDenied" }); };
    inv.invalidateProvider("sqs");
    out.denied = await look();
    out.deniedStatus = (await inv.getInventory()).providers.find((p) => p.id === "sqs");
    // First complete run without it: still shown, confirming; listed in the coverage view.
    sqs.discover = without();
    inv.invalidateProvider("sqs");
    out.confirming = await look();
    const cov = await inv.inventoryCoverage();
    out.coverage = { vanishing: cov.vanishing.map((v) => v.key), freshness: cov.freshness.notes ?? [] };
    // Second complete run without it: gone.
    inv.invalidateProvider("sqs");
    out.after = await look();
    out.coverageAfter = (await inv.inventoryCoverage()).vanishing.length;
    sqs.discover = discover;

    // CC-19: with an ok security-group run in every region, "allowed" edges come from its rules — no region's
    // Cloud.securityGroups() is called.
    const allowed = (v) => v.edges.filter((e) => e.confidence === "allowed").map((e) => e.from + ">" + e.to).sort();
    out.allowedBefore = allowed(first);
    out.sgOk = (first.providers.find((p) => p.id === "security-group")?.regions ?? []).map((r) => r.state);
    const sg = providerById("security-group");
    const saved = { discover: sg.discover, ...(sg.enabled ? { enabled: sg.enabled } : {}) };
    let calls = 0;
    const clouds = [await getCloud(), ...(await Promise.all([...(globalThis.__consoleClouds?.values() ?? [])]))];
    const reals = clouds.map((c) => c.securityGroups);
    clouds.forEach((c, i) => { c.securityGroups = async (x) => { calls++; return reals[i].call(c, x); }; });
    inv.invalidateProvider("security-group", "ecs");
    let viaProvider = await inv.getInventory();
    for (let i = 0; i < 40 && viaProvider.partial?.pendingRegions?.length; i++) { await new Promise((r) => setTimeout(r, 250)); viaProvider = await inv.getInventory(); }
    out.allowedVia = allowed(viaProvider);
    out.sgCalls = calls;
    // A failing run keeps its earlier result (30 min), rules included: the same edges (only groups it never listed are asked).
    sg.discover = async () => { throw new Error("boom"); };
    inv.invalidateProvider("security-group", "ecs");
    out.allowedFailing = allowed(await inv.getInventory());
    out.sgCallsFailing = calls;
    // …and where the provider has no rules at all (not set up), the inventory asks Cloud.securityGroups() itself.
    sg.enabled = () => ({ ok: false, why: "test: off" });
    inv.invalidateProvider("security-group", "ecs");
    out.allowedFallback = allowed(await inv.getInventory());
    out.sgCallsFallback = calls;
    clouds.forEach((c, i) => { c.securityGroups = reals[i]; });
    delete sg.enabled;
    Object.assign(sg, saved);

    // The payload: a weak ETag per build, the same for the same build.
    const a = await inv.inventoryPayload();
    const b = await inv.inventoryPayload();
    out.etag = { same: a.etag === b.etag, weak: a.etag.startsWith('W/"'), resources: a.view().resources.length };
    return out;
  `);
  const o = out as Record<string, unknown> & { before: object; capped: { vanishing: boolean }; denied: { vanishing: boolean }; confirming: { health: string; reason: string; vanishing: boolean }; coverage: { vanishing: string[]; freshness: string[] } };
  assert.ok(o.before, "the queue is on the map at first");
  assert.equal(o.capped?.vanishing, false, "a capped run removes nothing");
  assert.equal(o.denied?.vanishing, false, "a refused run removes nothing");
  assert.equal((o.deniedStatus as { state: string }).state, "denied");
  assert.match(String((o.deniedStatus as { error: string }).error), /showing what it found at \d\d:\d\d UTC/);
  assert.equal(o.confirming.vanishing, true);
  assert.equal(o.confirming.health, "unknown");
  assert.match(o.confirming.reason, /^not seen since \d\d:\d\d UTC — confirming$/);
  assert.deepEqual(o.coverage.vanishing, ["arn:aws:sqs:us-east-1:123456789012:acme-exports-old"]);
  assert.ok(o.coverage.freshness.includes("1 resource pending deletion confirmation"), JSON.stringify(o.coverage.freshness));
  assert.equal(o.after, null, "dropped after the second complete run without it");
  assert.equal(o.coverageAfter, 0);
  assert.ok((o.allowedBefore as string[]).length > 0);
  assert.ok((o.sgOk as string[]).length > 0 && (o.sgOk as string[]).every((s) => s === "ok"), JSON.stringify(o.sgOk));
  assert.deepEqual(o.allowedVia, o.allowedBefore, "the same allowed edges from the provider's rules");
  assert.equal(o.sgCalls, 0, "security groups read once: the provider's run, not Cloud.securityGroups()");
  assert.deepEqual(o.allowedFailing, o.allowedBefore, "a failing run's earlier rules still count");
  assert.ok((o.allowedFallback as string[]).length > 0);
  assert.ok((o.sgCallsFallback as number) > 0, "falls back to Cloud.securityGroups() when the provider's run isn't ok");
  assert.deepEqual(o.etag, { same: true, weak: true, resources: (o.etag as { resources: number }).resources });
});
