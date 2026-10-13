"use client";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { enter, exit, spring } from "./motion";

type Tone = "ok" | "error" | "info" | "busy";
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  link?: { href: string; label: string }; // opens in a new tab (e.g. "Open ticket")
}

const Ctx = createContext<{ push: (t: Omit<Toast, "id">, ms?: number) => number; update: (id: number, t: Partial<Omit<Toast, "id">>, ms?: number) => void }>({
  push: () => 0,
  update: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const schedule = useCallback((id: number, ms?: number) => {
    clearTimeout(timers.current.get(id));
    if (ms) timers.current.set(id, setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), ms));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">, ms = 5000) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-4), { ...t, id }]);
      schedule(id, t.tone === "busy" ? undefined : ms);
      return id;
    },
    [schedule],
  );
  const update = useCallback(
    (id: number, t: Partial<Omit<Toast, "id">>, ms = 5000) => {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...t } : x)));
      schedule(id, t.tone === "busy" ? undefined : ms);
    },
    [schedule],
  );

  return (
    <Ctx.Provider value={{ push, update }}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[100] flex flex-col gap-2 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[360px]" aria-live="polite">
        {/* Toasts rise 8px and settle; leaving ones shrink away in place while the stack closes up. */}
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: enter }}
              exit={{ opacity: 0, scale: 0.96, transition: exit }}
              transition={spring}
              className="pointer-events-auto flex gap-3 rounded-2xl border border-line bg-panel px-3.5 py-3 shadow-float"
            >
              <span className="mt-0.5">
                {t.tone === "ok" && <CheckCircle2 className="size-4 text-up" strokeWidth={1.75} />}
                {t.tone === "error" && <XCircle className="size-4 text-down" strokeWidth={1.75} />}
                {t.tone === "info" && <Info className="size-4 text-accent" strokeWidth={1.75} />}
                {t.tone === "busy" && <Loader2 className="size-4 animate-spin text-fg-3" strokeWidth={1.75} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">{t.title}</div>
                {t.body && <div className="mt-0.5 break-words text-xs text-fg-2">{t.body}</div>}
                {t.link && (
                  <a href={t.link.href} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-medium text-accent hover:underline">
                    {t.link.label} ↗
                  </a>
                )}
              </div>
              <button className="press -m-1 grid size-7 flex-none place-items-center self-start rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-9" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
