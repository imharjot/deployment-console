// Markdown-ish text → Atlassian Document Format (Jira Cloud v3 descriptions must be ADF, not strings).
// Covers what the console writes: paragraphs, line breaks, # headings, - bullets, ``` code fences, **bold**, `code`, links.
// https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

type Mark = { type: "strong" } | { type: "code" } | { type: "link"; attrs: { href: string } };
export type AdfInline = { type: "text"; text: string; marks?: Mark[] } | { type: "hardBreak" };
export type AdfNode =
  | { type: "paragraph"; content: AdfInline[] }
  | { type: "heading"; attrs: { level: number }; content: AdfInline[] }
  | { type: "codeBlock"; attrs?: { language: string }; content?: { type: "text"; text: string }[] }
  | { type: "bulletList"; content: { type: "listItem"; content: AdfNode[] }[] }
  | { type: "rule" };
export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

// Text nodes must be non-empty; code marks may only combine with links (we never nest, so each run has one mark).
export function inline(text: string): AdfInline[] {
  const out: AdfInline[] = [];
  const push = (t: string, marks?: Mark[]) => t && out.push(marks ? { type: "text", text: t, marks } : { type: "text", text: t });
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) push(tok.slice(2, -2), [{ type: "strong" }]);
    else if (tok.startsWith("`")) push(tok.slice(1, -1), [{ type: "code" }]);
    else if (tok.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      push(label, [{ type: "link", attrs: { href } }]);
    } else push(tok, [{ type: "link", attrs: { href: tok } }]);
    last = m.index + tok.length;
  }
  push(text.slice(last));
  return out;
}

const withBreaks = (lines: string[]): AdfInline[] => lines.flatMap((l, i) => (i ? [{ type: "hardBreak" } as AdfInline, ...inline(l)] : inline(l)));

export function toAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let para: string[] = [];
  let bullets: string[] = [];
  const flushPara = () => {
    const c = withBreaks(para);
    if (c.length) content.push({ type: "paragraph", content: c });
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length) content.push({ type: "bulletList", content: bullets.map((b) => ({ type: "listItem", content: [{ type: "paragraph", content: inline(b) }] })) });
    bullets = [];
  };
  const flush = () => {
    flushPara();
    flushBullets();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      const text = code.join("\n");
      const node: AdfNode = { type: "codeBlock" };
      if (fence[1]) node.attrs = { language: fence[1] };
      if (text) node.content = [{ type: "text", text }];
      content.push(node);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      content.push({ type: "heading", attrs: { level: heading[1].length }, content: inline(heading[2].trim()) });
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      content.push({ type: "rule" });
    } else if (bullet) {
      flushPara();
      bullets.push(bullet[1].trim());
    } else if (!line.trim()) {
      flush();
    } else {
      flushBullets();
      para.push(line);
    }
  }
  flush();
  return { type: "doc", version: 1, content };
}
