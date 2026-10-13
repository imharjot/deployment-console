"use client";
// Keeps a control whose options come from data (branches, environments, services) on one line: when it is wider
// than the screen it scrolls sideways, fading the edge with more to show, and starts at the selected option.
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { useEdgeFade } from "@/components/ui";

export function ScrollX({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useEdgeFade<HTMLDivElement>();
  return (
    <div ref={ref} className={clsx("edge-fade no-scrollbar min-w-0 max-w-full overflow-x-auto overscroll-x-contain", className)}>
      {children}
    </div>
  );
}
