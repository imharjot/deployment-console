// The inventory server module against the simulated account, in child processes (it imports "server-only", which only
// resolves under the react-server condition): the multi-region run plan, the eu-west-1 ECS services' keys, persisted
// runs (sealed mentions, nothing in clear) and the restart path that serves them labelled stale (R18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const INVENTORY = new URL("./inventory.ts", import.meta.url).href;
const DB = new URL("./db.ts", import.meta.url).href;
const CONFIG = new URL("../../../examples/demo.console.config.json", import.meta.url).pathname;

const scenario = (phase: "build" | "restore" | "foreign") => `
if (${JSON.stringify(phase)} === "foreign") {
  // The same data dir, but its rows were read from another account: never served.
  const { getDb } = await import(${JSON.stringify(DB)});
  const db = await getDb();
  for (const r of await db.all("SELECT provider, region, status FROM inventory_runs")) {
    const st = JSON.parse(r.status);
    await db.run("UPDATE inventory_runs SET status = ? WHERE provider = ? AND region = ?", [JSON.stringify({ ...st, account: "999999999999" }), r.provider, r.region]);
  }
}
const inv = await import(${JSON.stringify(INVENTORY)});
let v = await inv.getInventory();
// A build merges eu-west-1 in a second phase (regional providers with multiRegionMock): wait for it. The restore reads
// the persisted map once, as a restarted console would.
if (${JSON.stringify(phase)} !== "restore") {
  for (let i = 0; i < 40 && v.partial?.pendingRegions?.length; i++) {
    await new Promise((r) => setTimeout(r, 250));
    v = await inv.getInventory();
  }
}
const out = {
  keys: v.resources.map((r) => r.key).sort(),
  regions: v.regions, homeRegion: v.homeRegion, partial: v.partial ?? null,
  completeness: v.completeness,
  stale: v.providers.filter((p) => /refreshing/.test(p.error ?? "")).map((p) => p.id),
  ecs: v.providers.find((p) => p.id === "ecs"),
  eu: v.resources.filter((r) => r.region === "eu-west-1").map((r) => ({ key: r.key, env: r.env })),
};
if (${JSON.stringify(phase)} === "build") {
  await new Promise((r) => setTimeout(r, 1000)); // the saves are fire-and-forget
  const { getDb } = await import(${JSON.stringify(DB)});
  const { gunzipSync } = await import("node:zlib");
  const rows = await (await getDb()).all("SELECT provider, region, status, result FROM inventory_runs");
  out.rows = rows.map((r) => r.provider + "@" + r.region).sort();
  const text = rows.map((r) => gunzipSync(Buffer.from(r.result, "base64")).toString("utf8")).join("\\n");
  // Secret values from the simulated task definitions, and any connection string that carries credentials (a scrubbed
  // one, like a CloudFormation output's postgres://host:5432/db, is fine).
  out.leaks = ["pg-api-production-pass", "jwt-fake"].filter((s) => text.includes(s));
  if (/[a-z][a-z0-9+.-]*:\\/\\/[^\\s"'@\\/]+:[^\\s"'@\\/]+@/i.test(text)) out.leaks.push("credentials in a URL");
  out.sealed = text.includes('"mentions":"v1:');
}
console.log(JSON.stringify(out));
process.exit(0);
`;

function run(phase: "build" | "restore" | "foreign", dir: string) {
  const out = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario(phase)], {
    env: {
      ...process.env, DATABASE_URL: "", CONSOLE_SOURCE: "mock", CONSOLE_REGIONS: "us-east-1,eu-west-1", CONSOLE_CONFIG: CONFIG,
      CONSOLE_DATA_DIR: dir, CONSOLE_SQLITE_PATH: path.join(dir, "console.db"), CONSOLE_SECRET_KEY: "x".repeat(40),
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("multi-region mock build: home keys unchanged, eu ECS services keyed @eu-west-1, runs persisted with sealed mentions; a restart serves them stale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "inventory-runs-"));
  try {
    const b = run("build", dir);
    assert.deepEqual(b.regions, ["us-east-1", "eu-west-1"]);
    assert.equal(b.homeRegion, "us-east-1");
    assert.ok(b.keys.includes("ecs:service/acme-production/api"), "the home service keeps its region-less key");
    assert.ok(b.keys.includes("ecs:service/acme-production/api@eu-west-1"), "the eu service of the same cluster name gets its own key");
    const euEcs = b.eu.filter((r: { key: string }) => r.key.startsWith("ecs:service/"));
    assert.ok(euEcs.length > 0 && euEcs.every((r: { key: string; env: string }) => r.key.endsWith("@eu-west-1") && r.env === "production-eu-west-1"), JSON.stringify(euEcs));
    // Every eu-west-1 key is regional: a console key with @eu-west-1, or an ARN in eu-west-1 (regional providers with
    // multiRegionMock answer there; S3 is global and its eu bucket's ARN carries no region).
    assert.ok(b.keys.filter((k: string) => k.includes("eu-west-1")).every((k: string) => k.endsWith("@eu-west-1") || k.split(":")[3] === "eu-west-1"), "eu keys are regional");
    // Tags naming "production" in eu-west-1 place a resource in that region's environment (assign.ts regionalEnv).
    assert.ok(!b.eu.some((r: { env?: string }) => r.env === "production"), JSON.stringify(b.eu.filter((r: { env?: string }) => r.env === "production")));
    assert.equal(b.ecs.state, "ok");
    assert.ok(b.completeness && typeof b.completeness.lastCompleteAt === "number");
    assert.ok(b.rows.includes("ecs@us-east-1") && b.rows.includes("lambda@us-east-1"), b.rows.join(","));
    assert.deepEqual(b.leaks, [], "no environment value in clear in the DB");
    assert.equal(b.sealed, true);

    const r = run("restore", dir);
    assert.deepEqual(r.keys, b.keys, "the first read after a restart is the persisted map");
    assert.ok(r.stale.includes("ecs") && r.stale.includes("lambda"), "labelled stale while it refreshes");
    assert.match(r.ecs.error, /from \d\d:\d\d UTC — refreshing/);
    assert.ok(r.completeness.staleProviders.includes("ecs@us-east-1"));

    const f = run("foreign", dir);
    assert.deepEqual(f.stale, [], "rows another account wrote are never served: the first read is a fresh build");
    assert.deepEqual(f.keys, b.keys);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
