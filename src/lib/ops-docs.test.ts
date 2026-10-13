// Keeps docs/operations.md complete: every operation declared in src/lib/server/ops/*.ts (a `name: "<area>.<verb>"`
// line) must appear in the reference, written as `<area>.<verb>`. Reads the files as text — no server imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFile(new URL(p, root), "utf8");

async function declaredOps(): Promise<Map<string, string>> {
  const dir = "src/lib/server/ops/";
  const files = (await readdir(new URL(dir, root))).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const out = new Map<string, string>();
  for (const f of files) for (const m of (await read(dir + f)).matchAll(/\bname:\s*"([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9]+)"/g)) out.set(m[1], f);
  return out;
}

test("every operation is in docs/operations.md", async () => {
  const ops = await declaredOps();
  assert.ok(ops.size >= 20, `expected the core operations to be found, got ${ops.size}`);
  const doc = await read("docs/operations.md");
  const missing = [...ops].filter(([name]) => !doc.includes(`\`${name}\``)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, [], `add these to docs/operations.md: ${missing.join(", ")}`);
});

test("docs/operations.md lists no operation that doesn't exist", async () => {
  const ops = await declaredOps();
  const doc = await read("docs/operations.md");
  // Table rows start with | `area.verb` |
  const listed = [...doc.matchAll(/^\|\s*`([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9]+)`\s*\|/gm)].map((m) => m[1]);
  const stale = listed.filter((n) => !ops.has(n));
  assert.deepEqual(stale, [], `remove or fix these rows in docs/operations.md: ${stale.join(", ")}`);
});
