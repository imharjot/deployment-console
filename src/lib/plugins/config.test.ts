import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, open, redact } from "./config.ts";
import { jira } from "./jira.ts";
import type { Field } from "./types.ts";

// Stand-in sealing: reversible and visibly different from the plain value.
const seal = (s: string) => `sealed(${s})`;
const unseal = (s: string) => s.replace(/^sealed\((.*)\)$/, "$1");

const fields: Field[] = [
  { key: "url", label: "URL", type: "url", required: true },
  { key: "token", label: "Token", type: "secret", required: true },
  { key: "extra", label: "Extra", type: "secret" },
  { key: "mode", label: "Mode", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
];

test("redact never returns secret values, only { set: true }", () => {
  const out = redact(fields, { url: "https://x.io", token: "sealed(abc)", mode: "a" });
  assert.deepEqual(out, { url: "https://x.io", token: { set: true }, mode: "a" });
  assert.ok(!JSON.stringify(out).includes("abc"));
  const j = redact(jira.fields, { siteUrl: "https://a.atlassian.net", email: "e@x", token: "sealed(t0k3n)", projectKey: "OPS" });
  assert.ok(!JSON.stringify(j).includes("t0k3n"));
  assert.deepEqual(j.token, { set: true });
});

test("merge seals new secrets and keeps stored ones when the input is empty or a {set} marker", () => {
  const first = merge(fields, {}, { url: " https://x.io ", token: "abc" }, seal);
  assert.ok(first.ok);
  assert.deepEqual(first.ok && first.stored, { url: "https://x.io", token: "sealed(abc)" });

  for (const keep of ["", { set: true }, undefined]) {
    const m = merge(fields, { url: "https://x.io", token: "sealed(abc)" }, { url: "https://y.io", token: keep }, seal);
    assert.ok(m.ok);
    assert.equal(m.ok && m.stored.token, "sealed(abc)", `keep with ${JSON.stringify(keep)}`);
    assert.deepEqual(m.ok && m.changed, ["url"]);
  }

  const replaced = merge(fields, { url: "https://x.io", token: "sealed(abc)" }, { token: "new" }, seal);
  assert.equal(replaced.ok && replaced.stored.token, "sealed(new)");

  const cleared = merge(fields, { url: "https://x.io", token: "sealed(abc)", extra: "sealed(e)" }, { extra: null }, seal);
  assert.ok(cleared.ok);
  assert.equal(cleared.ok && cleared.stored.extra, undefined);
  assert.deepEqual(cleared.ok && cleared.changed, ["extra"]);
});

test("merge validates required, url, select and types; ignores undeclared keys", () => {
  assert.deepEqual(merge(fields, {}, { url: "https://x.io" }, seal), { ok: false, error: "Token is required" });
  assert.deepEqual(merge(fields, {}, { url: "ftp://x", token: "t" }, seal), { ok: false, error: "URL must be an http(s) URL" });
  assert.deepEqual(merge(fields, {}, { url: "nope", token: "t" }, seal), { ok: false, error: "URL must be a URL" });
  assert.equal(merge(fields, {}, { url: "https://x.io", token: "t", mode: "z" }, seal).ok, false);
  assert.equal(merge(fields, {}, { url: "https://x.io", token: 5 }, seal).ok, false);
  const m = merge(fields, {}, { url: "https://x.io", token: "t", baseUrl: "http://evil", __proto__: { x: 1 } }, seal);
  assert.ok(m.ok);
  assert.deepEqual(Object.keys(m.ok ? m.stored : {}), ["url", "token"]);
});

test("open unseals secrets for the plugin and fills unset fields with empty strings", () => {
  assert.deepEqual(open(fields, { url: "https://x.io", token: "sealed(abc)" }, unseal), { url: "https://x.io", token: "abc", extra: "", mode: "" });
});
