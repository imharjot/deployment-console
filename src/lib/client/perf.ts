"use client";
// Effects level on <html data-perf>: "lite" drops background blur and endless animations, keeps transitions short and
// polls half as often, so the console stays smooth on weak hardware. It is set before first paint (layout.tsx) from
// the saved choice, else from the device: ≤ 4 CPU threads, ≤ 4 GB memory, Save-Data or "reduce motion" → lite.
import { useSyncExternalStore } from "react";
import type { Middleware } from "swr";

export type PerfChoice = "auto" | "full" | "lite";
export type PerfLevel = "full" | "lite";
const KEY = "console.perf"; // also read by the pre-paint script in layout.tsx

const read = (): PerfLevel => (document.documentElement.dataset.perf === "lite" ? "lite" : "full");
function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-perf", "data-perf-choice"] });
  return () => mo.disconnect();
}

export const usePerfLevel = () => useSyncExternalStore(subscribe, read, () => "full" as const);

export function usePerfChoice() {
  const level = usePerfLevel();
  const choice = useSyncExternalStore(subscribe, readChoice, () => "auto" as const);
  const detected = useSyncExternalStore(subscribe, readDetected, () => "full" as const);
  const set = (c: PerfChoice) => {
    try {
      if (c === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      /* storage blocked: applies to this page only */
    }
    const d = document.documentElement;
    d.dataset.perfChoice = c;
    d.dataset.perf = c === "auto" ? (d.dataset.perfAuto ?? "full") : c;
  };
  return { level, choice, detected, set };
}

const readDetected = (): PerfLevel => (document.documentElement.dataset.perfAuto === "lite" ? "lite" : "full");

function readChoice(): PerfChoice {
  const c = document.documentElement.dataset.perfChoice;
  if (c === "auto" || c === "full" || c === "lite") return c;
  try {
    const s = localStorage.getItem(KEY);
    return s === "full" || s === "lite" ? s : "auto";
  } catch {
    return "auto";
  }
}

// SWR middleware: in lite mode every numeric polling interval doubles (an overview every 20 s instead of 10).
export const slowerWhenLite: Middleware = (useSWRNext) => (key, fetcher, config) => {
  const lite = usePerfLevel() === "lite";
  const every = config.refreshInterval;
  return useSWRNext(key, fetcher, lite && typeof every === "number" && every > 0 ? { ...config, refreshInterval: every * 2 } : config);
};
