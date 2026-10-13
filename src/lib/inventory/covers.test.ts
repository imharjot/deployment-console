// What each provider says it lists (`covers`: Resource Explorer types, audit §6 A.0 rule 8) against the checked-in
// snapshot of `aws resource-explorer-2 list-supported-resource-types` (aws-resource-types.json). The catch-all keeps a
// generic row out of the map only when a provider covering its type listed that region completely (B.4), so a
// misspelt or unknown type here would show every such resource twice. The registry is loaded the way
// `npm run iam:policy -- --json` loads it: provider modules import "server-only", so a child process with
// --conditions=react-server dumps the declarations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Declaration } from "../permissions.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const snapshot = JSON.parse(readFileSync(new URL("./aws-resource-types.json", import.meta.url), "utf8")) as { types: string[] };
const TYPES = new Set(snapshot.types);

let declsP: Promise<Declaration[]> | undefined;
function declarations(): Promise<Declaration[]> {
  declsP ??= (async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // the child is a script, not a test file
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "scripts/iam-policy.mjs", "--json"], { cwd: root, env, timeout: 90_000, maxBuffer: 32 << 20 });
    return (JSON.parse(stdout) as { providers: Declaration[] }).providers;
  })();
  return declsP;
}

test("every provider's covers entry is a Resource Explorer type in aws-resource-types.json", async () => {
  const decls = await declarations();
  assert.ok(decls.length > 0, "no providers registered");
  const unknown = decls.flatMap((d) => (d.covers ?? []).filter((t) => !TYPES.has(t)).map((t) => `${d.id}: "${t}"`));
  assert.deepEqual(unknown, [], "not in src/lib/inventory/aws-resource-types.json — use Resource Explorer's spelling, sub-types included (elasticloadbalancing:loadbalancer/app)");
  const total = decls.reduce((n, d) => n + (d.covers?.length ?? 0), 0);
  assert.ok(total >= 60, `${total} covered types`);
});

test("each type is covered by one provider, and a provider covers a type once", async () => {
  const by = new Map<string, string[]>();
  for (const d of await declarations()) {
    assert.equal(new Set(d.covers ?? []).size, (d.covers ?? []).length, `${d.id} lists a type twice`);
    for (const t of d.covers ?? []) by.set(t, [...(by.get(t) ?? []), d.id]);
  }
  assert.deepEqual([...by].filter(([, ids]) => ids.length > 1).map(([t, ids]) => `${t}: ${ids.join(", ")}`), []);
});

test("providers that cover types say where they run; the catch-all runs last and covers nothing itself", async () => {
  const decls = await declarations();
  for (const d of decls) {
    if (d.covers?.length) assert.ok(d.scope && d.kinds?.length, `${d.id}: a provider with covers declares its scope and kinds`);
    if (d.homeRegion) assert.equal(d.scope, "global", `${d.id}: homeRegion is only for scope "global"`);
  }
  const last = decls.at(-1);
  assert.equal(last?.id, "catchall", "the catch-all runs last: it keeps out what the providers before it cover");
  assert.deepEqual(last?.covers ?? [], []);
});
