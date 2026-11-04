// How often the console syncs with AWS in the background (the sampler in src/lib/server/console.ts and the CI watcher
// in src/lib/server/events.ts). Pure, so the pacing is tested on its own.
//
// - Someone is using the console (a signed-in person made a request in the last 15 minutes): every sync interval,
//   CONSOLE_SYNC_MINUTES (default 5).
// - A change is waiting to be verified (a restart, a rollback, a scale…): every 30 seconds until it settles, whoever
//   is or isn't looking, so "AWS accepted" still becomes "verified" or "failed".
// - Nobody is using it and nothing is pending: no background sync at all. The first request after that syncs at once.
// Pages someone has open still read AWS live for what they show; this only paces what runs in the background.

export const IDLE_AFTER_MS = 15 * 60_000;
export const PENDING_SYNC_MS = 30_000;
export const DEFAULT_SYNC_MINUTES = 5;

// CONSOLE_SYNC_MINUTES: 1–60, default 5. Anything else means the default.
export function syncIntervalMs(env: Record<string, string | undefined>): number {
  const raw = (env.CONSOLE_SYNC_MINUTES ?? "").trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return (n >= 1 && n <= 60 ? n : DEFAULT_SYNC_MINUTES) * 60_000;
}

export const isActive = (lastActiveAt: number, now: number) => lastActiveAt > 0 && now - lastActiveAt <= IDLE_AFTER_MS;

// The wait before the next background sync, or null to pause until someone comes back.
export function nextSyncDelay(o: { lastActiveAt: number; pending: number; intervalMs: number; now: number }): number | null {
  if (o.pending > 0) return Math.min(PENDING_SYNC_MS, o.intervalMs);
  return isActive(o.lastActiveAt, o.now) ? o.intervalMs : null;
}
