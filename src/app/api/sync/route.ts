// "Refresh now": sync with AWS at once (cached reads dropped, a full background sync run and awaited), and the
// background sync's state for the header. Once per 15 seconds across everyone: the sync is shared.
import { samplerHealth, syncNow } from "@/lib/server/console";
import { HttpError } from "@/lib/server/errors";
import { handle, json, userOf } from "@/lib/server/http";
import { lastActiveAt } from "@/lib/server/presence";

const GAP_MS = 15_000;
const g = globalThis as { __consoleSyncNowAt?: number };

const status = () => {
  const s = samplerHealth();
  return { lastSyncAt: s.lastTickAt ?? null, nextSyncAt: s.nextAt ?? null, running: s.running, intervalMs: s.intervalMs, pendingChanges: s.pending, lastActiveAt: lastActiveAt() || null };
};

export const GET = handle(async (req) => {
  userOf(req);
  return json(status());
});

export const POST = handle(async (req) => {
  userOf(req);
  const since = Date.now() - (g.__consoleSyncNowAt ?? 0);
  if (since < GAP_MS) throw new HttpError(429, "Synced a moment ago. Try again in a few seconds.", GAP_MS - since);
  g.__consoleSyncNowAt = Date.now();
  await syncNow();
  return json(status());
});
