import { readFile } from "node:fs/promises";
import path from "node:path";
import { Marked, type Tokens } from "marked";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ALL_PAGES } from "../nav";

// Docs are the markdown files in /docs, rendered at build time (no runtime file access, works in standalone builds).
export const dynamic = "force-static";
export const generateStaticParams = () => ALL_PAGES.map((p) => ({ slug: p.slug === "index" ? [] : [p.slug] }));
// Every page is known at build time, so any other slug is a 404 at routing (the app's not-found page). Letting it
// render and throw notFound() instead makes Next send its error shell and re-render the root on the client, which
// drops the theme set before paint and logs "Encountered a script tag" for the layout's theme script.
export const dynamicParams = false;

// Heading text arrives as HTML (marked escapes it): strip tags and decode the few entities marked emits.
const plain = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Apostrophes vanish like on GitHub ("What you'll need" → what-youll-need), so the same #anchors work in both places.
const id = (html: string) => plain(html).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const attr = (text: string) => text.replace(/[`*_]/g, "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function render(slug: string) {
  const md = await readFile(path.join(process.cwd(), "docs", `${slug}.md`), "utf8").catch(() => null);
  if (md === null) return null;
  const toc: { depth: number; text: string; id: string }[] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const hid = id(text);
        if (depth === 2 || depth === 3) toc.push({ depth, text: plain(text), id: hid });
        // The "#" is a mouse affordance: hidden from screen readers and the tab order so the heading's name is its text.
        return `<h${depth} id="${hid}"><a class="anchor" href="#${hid}" aria-hidden="true" tabindex="-1">#</a>${text}</h${depth}>`;
      },
      // Each cell carries its column name so tables of three or more columns can become labelled cards on
      // phones (docs.css); the wrapper scrolls any table that is still too wide.
      table({ header, rows }) {
        const cell = (c: Tokens.TableCell, tag: "th" | "td", label?: string) =>
          `<${tag}${c.align ? ` align="${c.align}"` : ""}${label ? ` data-label="${attr(label)}"` : ""}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${header.map((c) => cell(c, "th")).join("")}</tr>`;
        const body = rows.map((r) => `<tr>${r.map((c, i) => cell(c, "td", header[i]?.text)).join("")}</tr>`).join("");
        return `<div class="table-wrap"><table${header.length >= 3 ? ' class="stack"' : ""}><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        // "discovery.md#tags" → "/docs/discovery#tags" so the same links work on GitHub and in the app.
        const local = /^(?!https?:|mailto:|#)([\w-]+)\.md(#.*)?$/.exec(href ?? "");
        const to = local ? `/docs/${local[1] === "index" ? "" : local[1]}${local[2] ?? ""}` : href;
        const ext = /^https?:/.test(href ?? "");
        return `<a href="${to}"${ext ? ' target="_blank" rel="noreferrer"' : ""}>${text}</a>`;
      },
    },
  });
  const html = await marked.parse(md);
  return { html, toc, title: /^#\s+(.+)$/m.exec(md)?.[1] ?? slug };
}

export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  const slug = (await params).slug?.[0] ?? "index";
  // The index is "Docs · Deployment Console"; a page puts its own title first (F43).
  if (slug === "index") return { title: "Docs · Deployment Console" };
  const r = await render(slug);
  return { title: r ? `${r.title} · Docs · Deployment Console` : "Docs · Deployment Console" };
}

export default async function DocPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const slug = (await params).slug?.[0] ?? "index";
  if (!ALL_PAGES.some((p) => p.slug === slug)) notFound();
  const r = await render(slug);
  if (!r) notFound();
  const i = ALL_PAGES.findIndex((p) => p.slug === slug);
  const prev = ALL_PAGES[i - 1], next = ALL_PAGES[i + 1];
  return (
    <div className="flex gap-10">
      <article className="doc min-w-0 max-w-[780px] flex-1">
        <div dangerouslySetInnerHTML={{ __html: r.html }} />
        <nav aria-label="Previous and next page" className="mt-12 grid grid-cols-2 gap-3 border-t border-line pt-5 text-[14px]">
          {prev ? <Pager href={prev.slug === "index" ? "/docs" : `/docs/${prev.slug}`} dir="Previous" title={prev.title} /> : <span />}
          {next ? <Pager href={`/docs/${next.slug}`} dir="Next" title={next.title} /> : <span />}
        </nav>
      </article>
      {r.toc.length > 2 && (
        <aside className="sticky top-20 hidden h-fit w-48 flex-none xl:block">
          <div className="eyebrow mb-2">On this page</div>
          <ul className="space-y-1 text-[13px]">
            {r.toc.map((t) => (
              <li key={t.id} className={t.depth === 3 ? "pl-3" : ""}>
                <a href={`#${t.id}`} className="text-fg-3 hover:text-fg">{t.text}</a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

// Full-width tap targets for the previous / next page (the next one right-aligned).
function Pager({ href, dir, title }: { href: string; dir: "Previous" | "Next"; title: string }) {
  return (
    <Link href={href} className={`group rounded-xl border border-line px-3.5 py-3 transition-colors hover:border-line-strong hover:bg-panel-2 ${dir === "Next" ? "col-start-2 text-right" : ""}`}>
      <div className="eyebrow">{dir}</div>
      <div className="mt-0.5 text-fg-2 group-hover:text-fg">{dir === "Previous" ? `← ${title}` : `${title} →`}</div>
    </Link>
  );
}
