// List, then enrich (R18; pure): per-item detail calls run through a small worker pool instead of all being queued at
// once, and the time budget is checked when each item STARTS — not when it was queued — so an item that would begin
// after the budget is skipped instead of running late. Whatever finished is kept, with each item's state, so the
// provider can return its base list promptly and mark what it couldn't enrich.
import type { EnrichState } from "./inventory/types.ts";

export interface EnrichOptions {
  concurrency: number; // items in flight at once
  until?: number; // epoch ms: an item that would start after this is skipped
  signal?: AbortSignal; // the run's deadline: once aborted, nothing more starts
  max?: number; // enrich only the first `max` items; the rest are "capped"
}

export interface EnrichResult<R> {
  results: (R | undefined)[]; // same order and length as the items; undefined unless state is "ok"
  state: EnrichState[];
  skippedForTime: number; // items not started because of `until` or the signal (or cut short by the signal)
  capped: number; // items past `max`
}

// The same test as providers/types.ts deniedAction(), kept here so this module stays pure.
export const isDenied = (e: unknown): boolean => {
  const err = e as { name?: string; Code?: string; message?: string } | undefined;
  return /AccessDenied|UnauthorizedOperation|AuthorizationError|Forbidden|NotAuthorized/i.test(err?.name ?? err?.Code ?? "") || /not authorized to perform/i.test(err?.message ?? "");
};

export async function enrichAll<T, R>(items: T[], o: EnrichOptions, fn: (item: T) => Promise<R>): Promise<EnrichResult<R>> {
  const n = items.length;
  const max = o.max === undefined || Number.isNaN(o.max) ? n : Math.max(0, Math.min(n, Math.floor(o.max)));
  const results: (R | undefined)[] = new Array(n).fill(undefined);
  const state: EnrichState[] = new Array(n).fill("capped");
  let skippedForTime = 0;
  let next = 0;
  const late = () => !!o.signal?.aborted || (o.until !== undefined && Date.now() > o.until);
  const worker = async () => {
    while (next < max) {
      const i = next++;
      if (late()) {
        state[i] = "skipped";
        skippedForTime++;
        continue;
      }
      try {
        results[i] = await fn(items[i]);
        state[i] = "ok";
      } catch (e) {
        if (o.signal?.aborted) {
          state[i] = "skipped";
          skippedForTime++;
        } else state[i] = isDenied(e) ? "denied" : "error";
      }
    }
  };
  const workers = Math.max(1, Math.min(max, Math.floor(o.concurrency) || 1));
  await Promise.all(Array.from({ length: max ? workers : 0 }, worker));
  return { results, state, skippedForTime, capped: n - max };
}
