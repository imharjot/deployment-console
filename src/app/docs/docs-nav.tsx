"use client";
import { AnimatePresence } from "motion/react";
import { ChevronRight, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Sheet } from "@/components/motion";
import { IconButton, cx } from "@/components/ui";
import { ALL_PAGES, DOCS } from "./nav";

const href = (slug: string) => (slug === "index" ? "/docs" : `/docs/${slug}`);

function useCurrent() {
  const path = usePathname();
  return path === "/docs" ? "index" : path.replace(/^\/docs\//, "");
}

export function DocsNav({ onNavigate }: { onNavigate?: () => void }) {
  const current = useCurrent();
  return (
    <nav aria-label="Documentation" className="space-y-5">
      {DOCS.map((s) => (
        <div key={s.section}>
          <div className="eyebrow mb-1.5 px-2">{s.section}</div>
          <ul className="space-y-0.5">
            {s.pages.map((p) => (
              <li key={p.slug}>
                <Link
                  href={href(p.slug)}
                  onClick={onNavigate}
                  aria-current={current === p.slug ? "page" : undefined}
                  className={cx(
                    "block rounded-md px-2 py-1 text-[14px] transition-colors pointer-coarse:py-2.5 pointer-coarse:text-[15px]",
                    current === p.slug ? "bg-panel-3 font-medium text-fg" : "text-fg-3 hover:bg-panel-2 hover:text-fg-2",
                  )}
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

// Below `lg` the sidebar is hidden: a slim bar under the header names the page and opens the nav in a sheet.
export function DocsMenu() {
  const [open, setOpen] = useState(false);
  const current = useCurrent();
  const page = ALL_PAGES.find((p) => p.slug === current);
  const section = DOCS.find((s) => s.pages.some((p) => p.slug === current))?.section;
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="press flex h-11 w-full items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5 text-left text-[14px] shadow-card [--press-scale:0.985]"
      >
        <Menu className="size-4 flex-none text-fg-3" />
        <span className="min-w-0 flex-1 truncate">
          {section && <span className="text-fg-3">{section}</span>}
          {section && <ChevronRight className="mx-1 inline size-3 text-fg-3" />}
          <span className="font-medium text-fg">{page?.title ?? "Documentation"}</span>
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <Sheet onClose={() => setOpen(false)} side="left" as="aside" z="z-[70]" aria-label="Documentation" className="flex h-full w-[min(320px,86vw)] flex-col overflow-y-auto overscroll-contain rounded-r-2xl border-r border-line bg-panel px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] shadow-float">
            <div className="mb-3 flex items-center justify-between pl-2">
              <Link href="/docs" onClick={() => setOpen(false)} className="text-[16px] font-medium tracking-tight">Documentation</Link>
              <IconButton label="Close" onClick={() => setOpen(false)}>
                <X className="size-4" />
              </IconButton>
            </div>
            <DocsNav onNavigate={() => setOpen(false)} />
          </Sheet>
        )}
      </AnimatePresence>
    </>
  );
}
