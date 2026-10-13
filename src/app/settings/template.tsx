"use client";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { EASE } from "@/components/motion";

// Switching settings sections: the navigation stays put while the section's content fades up 6px (enter only).
export default function SettingsTemplate({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: EASE }}>
      {children}
    </motion.div>
  );
}
