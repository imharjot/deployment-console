// JUnit XML from node:test (--test-reporter=junit) and gotestsum. Both are machine-generated and regular,
// so a small scanner is enough — no XML dependency.
import type { TestCase, TestReport } from "./types.ts";

const ENT: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENT[m]);

const attrs = (s: string) => {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
};

export function parseJUnit(xml: string, file = ""): TestCase[] {
  const cases: TestCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]);
    const body = m[2] ?? "";
    const f = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const tc: TestCase = { suite: a.classname || a.file || file, name: a.name ?? "(unnamed)", seconds: Number(a.time) || 0 };
    if (f) {
      const fa = attrs(f[2]);
      tc.failure = [fa.message, decode(f[3] ?? "").trim()].filter(Boolean).join("\n").slice(0, 4000);
    }
    if (/<skipped\b/.test(body)) tc.skipped = true;
    cases.push(tc);
  }
  return cases;
}

export function summarize(files: { name: string; xml: string }[]): TestReport {
  const all = files.flatMap((f) => parseJUnit(f.xml, f.name));
  const failures = all.filter((c) => c.failure);
  return {
    total: all.length,
    failed: failures.length,
    skipped: all.filter((c) => c.skipped).length,
    seconds: Math.round(all.reduce((s, c) => s + c.seconds, 0) * 10) / 10,
    failures: failures.slice(0, 200),
    files: files.map((f) => f.name),
  };
}
