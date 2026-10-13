import { test } from "node:test";
import assert from "node:assert/strict";
import { inline, toAdf } from "./adf.ts";

test("paragraphs split on blank lines; single newlines become hardBreaks", () => {
  assert.deepEqual(toAdf("one\ntwo\n\nthree"), {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }] },
      { type: "paragraph", content: [{ type: "text", text: "three" }] },
    ],
  });
});

test("fenced code keeps text verbatim (no marks) with language; empty fence has no empty text node", () => {
  const d = toAdf("before\n```ts\nconst a = `x` **not bold**\n  indented\n```\n```\n```");
  assert.deepEqual(d.content[1], { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = `x` **not bold**\n  indented" }] });
  assert.deepEqual(d.content[2], { type: "codeBlock" });
});

test("unterminated fence runs to the end instead of dropping text", () => {
  const d = toAdf("```\nline 1\nline 2");
  assert.deepEqual(d.content, [{ type: "codeBlock", content: [{ type: "text", text: "line 1\nline 2" }] }]);
});

test("headings, bullets and rules", () => {
  const d = toAdf("## Reasons\n- a\n* **b**\n---\nafter");
  assert.deepEqual(d.content[0], { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Reasons" }] });
  assert.deepEqual(d.content[1], {
    type: "bulletList",
    content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b", marks: [{ type: "strong" }] }] }] },
    ],
  });
  assert.deepEqual(d.content[2], { type: "rule" });
  assert.equal(d.content[3].type, "paragraph");
});

test("inline: bold, code, markdown links and bare URLs (trailing punctuation excluded)", () => {
  assert.deepEqual(inline("see **this** and `cfg` at [console](https://c.io/x?a=1) or https://gh.io/run/1."), [
    { type: "text", text: "see " },
    { type: "text", text: "this", marks: [{ type: "strong" }] },
    { type: "text", text: " and " },
    { type: "text", text: "cfg", marks: [{ type: "code" }] },
    { type: "text", text: " at " },
    { type: "text", text: "console", marks: [{ type: "link", attrs: { href: "https://c.io/x?a=1" } }] },
    { type: "text", text: " or " },
    { type: "text", text: "https://gh.io/run/1", marks: [{ type: "link", attrs: { href: "https://gh.io/run/1" } }] },
    { type: "text", text: "." },
  ]);
});

test("never emits empty text nodes (Jira rejects them) and CRLF is normalised", () => {
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as { type?: string; text?: string };
      if (o.type === "text") assert.ok(o.text && o.text.length > 0, "empty text node");
      Object.values(o).forEach(walk);
    }
  };
  walk(toAdf("\r\n\r\n**x**\r\n``\r\n- \r\n#\r\n"));
  assert.deepEqual(toAdf(""), { type: "doc", version: 1, content: [] });
});
