import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, inputHash, planHash } from "./plan-hash.ts";

const KEY = "test-hmac-key-derived-from-console-secret";

test("canonicalJson: keys sorted at every level, undefined dropped, arrays keep their order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson([undefined, NaN, () => 1]), "[null,null,null]");
  assert.equal(canonicalJson(new Date(0)), '"1970-01-01T00:00:00.000Z"');
  assert.equal(canonicalJson(undefined), "null");
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.throws(() => canonicalJson(loop), /circular/);
});

const plan = (o: Partial<Parameters<typeof planHash>[0]> = {}) => ({
  op: "variables.save",
  opVersion: "1",
  targets: ["ecs-service:us-east-1/acme-staging/api", "ssm:us-east-1/acme/staging/DB_PASSWORD"],
  input: { env: "staging", service: "api", set: { LOG_LEVEL: "debug", DB_PASSWORD: "hunter2" } },
  secretFields: ["set.DB_PASSWORD"],
  changes: ["set LOG_LEVEL", "set DB_PASSWORD"],
  preconditions: { revision: "arn:aws:ecs:us-east-1:123456789012:task-definition/api-staging:41" },
  ...o,
});

test("planHash: key order and target order don't matter", () => {
  const a = planHash(plan(), KEY);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  const reordered = plan({
    targets: ["ssm:us-east-1/acme/staging/DB_PASSWORD", "ecs-service:us-east-1/acme-staging/api"],
    input: { set: { DB_PASSWORD: "hunter2", LOG_LEVEL: "debug" }, service: "api", env: "staging" },
  });
  assert.equal(planHash(reordered, KEY), a);
});

test("planHash: a changed secret, non-secret field, target, operation, change list or precondition changes the hash", () => {
  const a = planHash(plan(), KEY);
  const variants = [
    plan({ input: { env: "staging", service: "api", set: { LOG_LEVEL: "debug", DB_PASSWORD: "hunter3" } } }),
    plan({ input: { env: "staging", service: "api", set: { LOG_LEVEL: "info", DB_PASSWORD: "hunter2" } } }),
    plan({ targets: ["ecs-service:us-east-1/acme-staging/worker"] }),
    plan({ op: "variables.delete" }),
    plan({ opVersion: "2" }),
    plan({ changes: ["set DB_PASSWORD", "set LOG_LEVEL"] }),
    plan({ preconditions: { revision: "arn:aws:ecs:us-east-1:123456789012:task-definition/api-staging:42" } }),
  ];
  const hashes = new Set(variants.map((v) => planHash(v, KEY)));
  assert.equal(hashes.size, variants.length);
  assert.ok(!hashes.has(a));
});

test("secrets are HMAC'd with the key, never hashed raw", () => {
  const input = { name: "DB_PASSWORD", value: "hunter2" };
  const h = inputHash(input, ["value"], KEY);
  assert.notEqual(h, inputHash(input, ["value"], "another-key"), "the key is part of a secret's contribution");
  assert.notEqual(h, inputHash(input, [], KEY), "a secret field is not hashed as plain input");
  const raw = createHash("sha256").update("hunter2").digest("hex");
  const rawJson = createHash("sha256").update('"hunter2"').digest("hex");
  assert.ok(!h.includes(raw) && !h.includes(rawJson));
  assert.notEqual(inputHash({ name: "DB_PASSWORD", value: "hunter3" }, ["value"], KEY), h, "a changed secret changes the hash");
  assert.notEqual(inputHash({ name: "OTHER", value: "hunter2" }, ["value"], KEY), h, "a changed non-secret changes the hash");
  assert.throws(() => inputHash(input, ["value"], ""), /HMAC key/);
  assert.match(inputHash({ name: "x" }, [], ""), /^sha256:/, "no secret present → no key needed");
});

test("secret paths support wildcards over keys and array items", () => {
  const input = (v: string) => ({ changes: [{ container: "api", set: { A: v, B: "plain" } }] });
  const fields = ["changes.*.set.A"];
  assert.notEqual(inputHash(input("one"), fields, KEY), inputHash(input("two"), fields, KEY));
  const everything = ["changes.*.set.*"];
  assert.notEqual(inputHash(input("one"), everything, KEY), inputHash(input("one"), fields, KEY));
  assert.equal(inputHash(input("one"), everything, KEY), inputHash(input("one"), everything, KEY));
});
