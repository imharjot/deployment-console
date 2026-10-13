// Page frame shared by every console page: one centred column, 16px gutters on phones and 24px from `sm`,
// and a header whose actions drop under the title when there is no room beside it.
// Plain functions (no "use client") so server layouts such as /docs can use them too.
import { clsx } from "clsx";
import type { ReactNode } from "react";

const WIDTH = { narrow: "max-w-[900px]", default: "max-w-[1200px]", wide: "max-w-[1400px]" } as const;

export function Page({ width = "default", className, children }: { width?: keyof typeof WIDTH; className?: string; children: ReactNode }) {
  return <div className={clsx("mx-auto w-full space-y-6 px-4 pb-12 pt-5 sm:px-6 sm:pt-7", WIDTH[width], className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0 max-w-2xl">
        <h1 className="text-[34px] leading-none sm:text-[40px]">{title}</h1>
        {description && <p className="mt-2 text-[14px] leading-relaxed text-fg-3">{description}</p>}
      </div>
      {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
    </header>
  );
}

// `top-*` for sticky elements that sit just under the shell's header (shorter on phones, plus the notch inset).
export const BELOW_HEADER = "top-[calc(3.25rem+env(safe-area-inset-top))] sm:top-14";

// Grows a small text link's hit area to 40px+ on touch screens without moving anything around it.
export const TAP = "pointer-coarse:-my-3 pointer-coarse:py-3";

// Section label used above groups of cards and charts.
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={clsx("eyebrow", className)}>{children}</h2>;
}
