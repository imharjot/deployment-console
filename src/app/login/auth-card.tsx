"use client";
// Shared chrome for the sign-in pages (/login, /setup, /invite): a centred card on the grid background.
import { AnimatePresence, motion } from "motion/react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { pop } from "@/components/motion";
import { LogoMark } from "@/components/ui";

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    // dvh + safe-area padding: the card stays centred and clear of the notch and home indicator on phones.
    <main className="relative z-[1] grid min-h-dvh place-items-center px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
      <motion.div {...pop} className="w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center gap-3">
          <LogoMark className="!size-10" />
          <div className="text-[14px] font-medium tracking-tight text-fg-2">Deployment Console</div>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-5 shadow-float sm:p-7">
          <h1 className="text-[30px] leading-tight">{title}</h1>
          {subtitle && <div className="mt-1 text-[14px] leading-relaxed text-fg-3">{subtitle}</div>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-5 text-center text-xs leading-relaxed text-fg-3">{footer}</div>}
      </motion.div>
    </main>
  );
}

export function Field({ label, hint, className, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return (
    <label className={className ?? "block"}>
      <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">{label}</span>
      <input
        {...input}
        className="h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-accent focus:bg-panel read-only:text-fg-2 disabled:opacity-60 pointer-coarse:h-11"
      />
      {hint && <span className="mt-1.5 block text-[12.5px] leading-snug text-fg-3">{hint}</span>}
    </label>
  );
}

export function FormError({ error }: { error: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {error && (
        <motion.div
          role="alert"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] leading-snug text-down">{error}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Client-side mirror of the server policy, for instant feedback only (the server re-checks).
export const passwordHint = (pw: string, confirm: string) =>
  pw && [...pw].length < 10 ? "Use at least 10 characters." : confirm && pw !== confirm ? "The passwords don't match." : null;
