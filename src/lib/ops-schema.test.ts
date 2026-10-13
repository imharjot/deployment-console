import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleInput, toAnthropicTool, toMcpTool, toOpenAiTool, toTools, toolName, validate } from "./ops-schema.ts";
import type { JsonSchema } from "./server/ops/types.ts";

const S: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["env", "service"],
  properties: {
    env: { type: "string", pattern: "^[a-z0-9-]+$" },
    service: { type: "string", minLength: 1, maxLength: 5 },
    count: { type: "integer", minimum: 1, maximum: 10 },
    ratio: { type: "number" },
    mode: { type: "string", enum: ["text", "pattern"] },
    dry: { type: "boolean" },
    tags: { type: "array", maxItems: 2, items: { type: "string" } },
    changes: {
      type: "object",
      properties: { plain: { type: "array", items: { type: "object", required: ["container"], additionalProperties: false, properties: { container: { type: "string" }, set: { type: "object" } } } } },
    },
  },
};

test("valid input has no problems", () => {
  assert.deepEqual(validate(S, { env: "staging", service: "api", count: 3, ratio: 0.5, mode: "text", dry: true, tags: ["a"], changes: { plain: [{ container: "api", set: { A: "1" } }] } }), []);
});

test("required, unknown fields and wrong types are reported with paths", () => {
  assert.deepEqual(validate(S, { extra: 1 }), ["env: required", "service: required", "extra: unknown field"]);
  assert.deepEqual(validate(S, "nope"), ["input: must be an object (got string)"]);
  assert.deepEqual(validate(S, { env: 1, service: "api" }), ["env: must be a string (got number)"]);
  assert.deepEqual(validate(S, { env: "a", service: "api", dry: "yes" }), ["dry: must be a boolean (got string)"]);
  assert.deepEqual(validate(S, { env: "a", service: "api", tags: "x" }), ["tags: must be a list (got string)"]);
});

test("string, number, enum and array constraints", () => {
  assert.deepEqual(validate(S, { env: "Bad Env", service: "" }), ["env: does not match ^[a-z0-9-]+$", "service: must be at least 1 characters"]);
  assert.deepEqual(validate(S, { env: "a", service: "toolong" }), ["service: must be at most 5 characters"]);
  assert.deepEqual(validate(S, { env: "a", service: "x", count: 2.5 }), ["count: must be an integer"]);
  assert.deepEqual(validate(S, { env: "a", service: "x", count: 0 }), ["count: must be ≥ 1"]);
  assert.deepEqual(validate(S, { env: "a", service: "x", count: 11 }), ["count: must be ≤ 10"]);
  assert.deepEqual(validate(S, { env: "a", service: "x", ratio: Number.NaN }), ["ratio: must be a number"]);
  assert.deepEqual(validate(S, { env: "a", service: "x", mode: "regex" }), ['mode: must be one of "text", "pattern"']);
  assert.deepEqual(validate(S, { env: "a", service: "x", tags: ["a", "b", 3] }), ["tags: at most 2 items", "tags[2]: must be a string (got number)"]);
});

test("nested objects and list items carry their full path", () => {
  assert.deepEqual(validate(S, { env: "a", service: "x", changes: { plain: [{ set: {} }, { container: "c", other: 1 }] } }), [
    "changes.plain[0].container: required",
    "changes.plain[1].other: unknown field",
  ]);
});

test("null is not a value of any type; undefined optional fields are ignored", () => {
  assert.deepEqual(validate(S, { env: "a", service: null }), ["service: must be a string (got null)"]);
  assert.deepEqual(validate(S, { env: "a", service: "x", count: undefined }), []);
});

test("problem lists are capped", () => {
  const many: JsonSchema = { type: "object", additionalProperties: false, properties: {} };
  const input = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  assert.equal(validate(many, input).length, 20);
});

const OP = { name: "services.restart", description: "Restart a service.", input: { type: "object", properties: { env: { type: "string" } }, required: ["env"] } as JsonSchema };

test("tool names replace dots with underscores", () => {
  assert.equal(toolName("services.restart"), "services_restart");
  assert.equal(toolName("envs.list"), "envs_list");
});

test("tool definitions per API", () => {
  assert.deepEqual(toAnthropicTool(OP), { name: "services_restart", description: "Restart a service.", input_schema: OP.input });
  assert.deepEqual(toOpenAiTool(OP), { type: "function", function: { name: "services_restart", description: "Restart a service.", parameters: OP.input } });
  assert.deepEqual(toMcpTool(OP), { name: "services_restart", description: "Restart a service.", inputSchema: OP.input });
  assert.deepEqual(toTools([OP], "mcp"), [toMcpTool(OP)]);
  assert.deepEqual(toTools([OP], "openai"), [toOpenAiTool(OP)]);
});

test("tool schemas are copies: changing one never changes the operation", () => {
  const t = toAnthropicTool(OP);
  (t.input_schema.properties as Record<string, JsonSchema>).env.type = "integer";
  assert.equal(OP.input.properties!.env.type, "string");
});

test("example input fills required fields with typed placeholders", () => {
  const s: JsonSchema = {
    type: "object",
    required: ["env", "limit", "mode", "on", "ids", "opts"],
    properties: {
      env: { type: "string" }, limit: { type: "integer", minimum: 5 }, mode: { type: "string", enum: ["a", "b"] }, on: { type: "boolean" },
      ids: { type: "array", items: { type: "string" } }, opts: { type: "object", properties: {} }, optional: { type: "string" },
    },
  };
  assert.deepEqual(exampleInput(s), { env: "<env>", limit: 5, mode: "a", on: false, ids: [], opts: {} });
  assert.equal(exampleInput({ type: "integer", default: 25 }), 25);
});

test("inherited names (constructor, toString, __proto__) are unknown fields, not known ones", () => {
  const input = JSON.parse('{"env":"a","service":"api","constructor":"x","toString":{},"__proto__":1,"changes":{"valueOf":[1]}}');
  assert.deepEqual(validate(S, input), ["constructor: unknown field", "toString: unknown field", "__proto__: unknown field"]);
});
