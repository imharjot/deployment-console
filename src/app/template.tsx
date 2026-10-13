"use client";
import { motion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { EASE } from "@/components/motion";

// The first page load is served as-is (no hidden-until-hydrated flash); client-side
// navigations fade up 6px. Enter only: the old page leaves at once. Transform and opacity only.
let booted = false;

export default function Template({ children }: { children: ReactNode }) {
  useEffect(() => {
    booted = true;
  }, []);
  if (!booted) return <div>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      // At rest motion writes `transform: none`, so `fixed` children (full-screen logs) keep the viewport.
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
