"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Unknown URLs render here, inside the shell, instead of Next's unstyled default. That includes /docs/<unknown>:
// the docs route serves only the pages it lists (dynamicParams = false), so a bad slug is a 404 at routing.
export default function NotFound() {
  const docs = /^\/docs(\/|$)/.test(usePathname() ?? "");
  return (
    <div className="mx-auto grid min-h-[70vh] w-full max-w-[640px] place-items-center px-4 sm:px-6">
      <div className="w-full rounded-3xl border border-line bg-panel p-6 shadow-card sm:p-8">
        <div className="eyebrow mb-3">404</div>
        <h1 className="text-[32px] leading-tight">Page not found</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-fg-3">
          {docs ? "There is no documentation page at this address. It may have been renamed, or the link has a typo." : "Nothing lives at this address. The link may be old or mistyped."}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href={docs ? "/docs" : "/"} className="press rounded-lg bg-primary px-3.5 py-2 text-[14px] font-medium text-primary-fg hover:bg-primary-hover">
            {docs ? "Back to the documentation" : "Go to the overview"}
          </Link>
        </div>
      </div>
    </div>
  );
}
