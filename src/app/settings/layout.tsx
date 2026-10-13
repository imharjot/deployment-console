"use client";
import { Lock } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { spring } from "@/components/motion";
import { cx, useEdgeFade } from "@/components/ui";
import { hue } from "@/components/hue";
import { useMe } from "@/components/user-menu";
import { Page } from "../_components/page-frame";
import { SETTINGS_GROUPS, lockedFor, sectionOf } from "./sections";

// Settings: grouped side navigation on wide screens (sticky under the header), a scrolling row of pills on narrow
// ones, and one header per section drawn from sections.ts. Each section is its own route; pages enforce their role.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/settings";
  const active = sectionOf(path);
  const role = useMe().data?.user.role;
  const pills = useEdgeFade<HTMLElement>(path); // re-centres the active pill on every section change
  return (
    <Page width="wide">
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-10">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <h1 className="text-[34px] leading-none sm:text-[40px]">Settings</h1>

          {/* Wide: grouped list. */}
          <nav aria-label="Settings sections" className="mt-7 hidden space-y-6 lg:block">
            {SETTINGS_GROUPS.map((g) => (
              <div key={g.label}>
                <div className="eyebrow mb-1.5 px-3">{g.label}</div>
                <ul className="space-y-0.5">
                  {g.items.map((s) => {
                    const on = s === active;
                    const locked = lockedFor(s, role);
                    return (
                      <li key={s.href}>
                        <Link
                          href={s.href}
                          aria-current={on ? "page" : undefined}
                          className={cx(
                            "press relative flex h-10 items-center gap-2.5 rounded-lg px-3 text-[14px] font-medium transition-colors duration-200",
                            on ? "text-fg" : "text-fg-2 hover:bg-panel-2 hover:text-fg",
                          )}
                        >
                          {on && <motion.span layoutId="settings-nav" className="absolute inset-0 -z-10 rounded-lg border border-line bg-panel shadow-card" transition={spring} />}
                          <s.icon className={cx("hue-text size-4 flex-none transition-opacity", !on && "opacity-80")} style={hue(s.hue)} />
                          <span className="truncate">{s.label}</span>
                          {locked && <Lock className="ml-auto size-3.5 flex-none text-fg-3" aria-label={`${s.role}s only`} />}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {/* Narrow: one scrolling row, fading the edge with more to show. */}
          <nav ref={pills} aria-label="Settings sections" className="edge-fade no-scrollbar relative -mx-4 mt-5 flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 sm:-mx-6 sm:px-6 lg:hidden">
            {SETTINGS_GROUPS.flatMap((g) => g.items).map((s) => {
              const on = s === active;
              return (
                <Link
                  key={s.href}
                  href={s.href}
                  aria-current={on ? "page" : undefined}
                  className={cx(
                    "press relative flex h-9 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[14px] font-medium transition-colors duration-200 pointer-coarse:h-10",
                    on ? "border-transparent text-fg" : "border-line text-fg-2 hover:text-fg",
                  )}
                >
                  {on && <motion.span layoutId="settings-pill" className="absolute inset-0 -z-10 rounded-full border border-accent/40 bg-panel-2" transition={spring} />}
                  <s.icon className="hue-text size-3.5" style={hue(s.hue)} />
                  {s.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <div className="mt-6 min-w-0 lg:mt-0 lg:pt-1">
          {active && active.href !== "/settings" && (
            <header className="mb-6 border-b border-line pb-5">
              <h2 className="flex items-center gap-2.5 font-display text-[26px] leading-tight">
                <span className="hue-chip grid size-9 place-items-center rounded-xl" style={hue(active.hue)}>
                  <active.icon className="size-[18px]" />
                </span>
                {active.label}
              </h2>
              <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-fg-2">{active.description}</p>
            </header>
          )}
          {children}
        </div>
      </div>
    </Page>
  );
}
