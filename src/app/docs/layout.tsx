import Link from "next/link";
import type { ReactNode } from "react";
import { DocsMenu, DocsNav } from "./docs-nav";
import "./docs.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] gap-10 px-4 pb-12 pt-5 sm:px-6 sm:pt-7">
      <aside className="sticky top-20 hidden h-[calc(100vh-6rem)] w-52 flex-none overflow-y-auto lg:block">
        <Link href="/docs" className="mb-5 block px-2 text-[16px] font-medium tracking-tight">Documentation</Link>
        <DocsNav />
      </aside>
      <div className="min-w-0 flex-1">
        <div className="mb-6 lg:hidden">
          <DocsMenu />
        </div>
        {children}
      </div>
    </div>
  );
}
