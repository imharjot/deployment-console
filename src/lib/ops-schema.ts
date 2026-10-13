// Validation of operation input against the JSON Schema subset in server/ops/types.ts, and conversion of operations
// into tool definitions for LLM APIs (Anthropic, OpenAI, MCP). Pure: shared by the registry, the MCP endpoint, the
// Automation page and the tests. Validation is the registry's first gate — input that fails it never reaches run().
import type { JsonSchema } from "./server/ops/types.ts";

const MAX_DEPTH = 12;
const MAX_PROBLEMS = 20;

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const at = (path: string) => path || "input";

// Every problem with a path ("input.changes.plain[0].container: required"). Empty = valid.
export function validate(schema: JsonSchema, value: unknown): string[] {
  const out: string[] = [];
  walk(schema, value, "", out, 0);
  return out.slice(0, MAX_PROBLEMS);
}

function walk(s: JsonSchema, v: unknown, path: string, out: string[], depth: number): void {
  if (out.length >= MAX_PROBLEMS) return;
  if (depth > MAX_DEPTH) {
    out.push(`${at(path)}: nested too deeply`);
    return;
  }
  const t = typeOf(v);
  switch (s.type) {
    case "object":
      if (t !== "object") return void out.push(`${at(path)}: must be an object (got ${t})`);
      break;
    case "array":
      if (t !== "array") return void out.push(`${at(path)}: must be a list (got ${t})`);
      break;
    case "integer":
      if (t !== "number" || !Number.isInteger(v)) return void out.push(`${at(path)}: must be an integer`);
      break;
    case "number":
      if (t !== "number" || !Number.isFinite(v)) return void out.push(`${at(path)}: must be a number`);
      break;
    case "string":
    case "boolean":
      if (t !== s.type) return void out.push(`${at(path)}: must be a ${s.type} (got ${t})`);
      break;
  }
  if (s.enum && !s.enum.includes(v as string | number)) out.push(`${at(path)}: must be one of ${s.enum.map((x) => JSON.stringify(x)).join(", ")}`);
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) out.push(`${at(path)}: must be at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && v.length > s.maxLength) out.push(`${at(path)}: must be at most ${s.maxLength} characters`);
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) out.push(`${at(path)}: does not match ${s.pattern}`);
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at(path)}: must be ≥ ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at(path)}: must be ≤ ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at(path)}: at most ${s.maxItems} items`);
    if (s.items) v.slice(0, 500).forEach((x, i) => walk(s.items!, x, `${path || "input"}[${i}]`, out, depth + 1));
  }
  if (t === "object" && (s.type === "object" || s.properties)) {
    const o = v as Record<string, unknown>;
    const props = s.properties ?? {};
    for (const k of s.required ?? []) if (!Object.hasOwn(o, k) || o[k] === undefined) out.push(`${path ? `${path}.` : ""}${k}: required`);
    for (const [k, x] of Object.entries(o)) {
      const p = `${path ? `${path}.` : ""}${k}`;
      // Own properties only: `props[k]` alone would accept "constructor", "toString" or "__proto__" (inherited from
      // Object.prototype) as known fields and skip their type checks.
      if (Object.hasOwn(props, k)) {
        if (x !== undefined) walk(props[k], x, p, out, depth + 1);
      } else if (s.additionalProperties === false) out.push(`${p}: unknown field`);
    }
  }
}

// ---------- tool definitions ----------

export interface ToolSource {
  name: string;
  description: string;
  input: JsonSchema;
}

// "services.restart" → "services_restart": tool names in every API allow [a-zA-Z0-9_-] only.
export const toolName = (opName: string) => opName.replace(/\./g, "_");

// A deep copy, so nothing downstream can mutate a registered operation's schema.
const clean = (s: JsonSchema): JsonSchema => JSON.parse(JSON.stringify(s)) as JsonSchema;

export const toAnthropicTool = (op: ToolSource) => ({ name: toolName(op.name), description: op.description, input_schema: clean(op.input) });
export const toOpenAiTool = (op: ToolSource) => ({ type: "function" as const, function: { name: toolName(op.name), description: op.description, parameters: clean(op.input) } });
export const toMcpTool = (op: ToolSource) => ({ name: toolName(op.name), description: op.description, inputSchema: clean(op.input) });

export type ToolFormat = "anthropic" | "openai" | "mcp";
export const TOOL_FORMATS: ToolFormat[] = ["anthropic", "openai", "mcp"];
export type Tool = ReturnType<typeof toAnthropicTool> | ReturnType<typeof toOpenAiTool> | ReturnType<typeof toMcpTool>;
export function toTools(ops: ToolSource[], format: ToolFormat): Tool[] {
  const f: (op: ToolSource) => Tool = format === "anthropic" ? toAnthropicTool : format === "openai" ? toOpenAiTool : toMcpTool;
  return ops.map(f);
}

// A placeholder input for docs and "copy curl": required fields only, each with a value that shows its type.
export function exampleInput(s: JsonSchema, key?: string): unknown {
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case "object": {
      const o: Record<string, unknown> = {};
      for (const k of s.required ?? []) if (s.properties?.[k]) o[k] = exampleInput(s.properties[k], k);
      return o;
    }
    case "array":
      return [];
    case "integer":
    case "number":
      return s.minimum ?? 1;
    case "boolean":
      return false;
    case "string":
      return key ? `<${key}>` : "…";
    default:
      return null;
  }
}
