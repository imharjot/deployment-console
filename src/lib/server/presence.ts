// When a person last used the console, for the background sync's pace (src/lib/sync-rules.ts). The proxy marks every
// signed-in person's request (not API tokens or agents); the sampler registers how to wake up. On globalThis: the proxy
// and the sampler are separate bundles in one process.
import "server-only";
import { isActive } from "../sync-rules.ts";

interface Presence {
  lastActiveAt: number;
  wake?: (delayMs: number) => void; // set by the sampler (console.ts)
}
const g = globalThis as { __consolePresence?: Presence };
const p: Presence = (g.__consolePresence ??= { lastActiveAt: 0 });

// After a pause, the first request syncs at once. A change (any write) syncs shortly after, so the operation it may have
// started is seen and verified on the 30-second pace (the delay lets AWS accept it first).
export function markActive(write: boolean, now = Date.now()) {
  const wasIdle = !isActive(p.lastActiveAt, now);
  p.lastActiveAt = now;
  if (wasIdle) p.wake?.(0);
  else if (write) p.wake?.(5_000);
}

export const lastActiveAt = () => p.lastActiveAt;
export const onWake = (f: (delayMs: number) => void) => void (p.wake = f);
