// A counting semaphore for runtime CLI processes: at most limit() run at once (CONSOLE_RUNTIME_CONCURRENCY, default 1),
// the rest wait first come, first served. A subscription CLI is one person's interactive login; running many copies at
// once burns their allowance and their machine. Pure: the server keeps one instance on globalThis, so routes and the
// worker share the count.

export class SlotWaitError extends Error {
  readonly reason: "cancelled" | "deadline";
  constructor(reason: "cancelled" | "deadline") {
    super(reason === "cancelled" ? "cancelled while waiting for a free runtime slot" : "the run's deadline passed while it waited for a free runtime slot");
    this.reason = reason;
  }
}

export interface Slots {
  // Resolves with a release function (idempotent) once a slot is free; onQueued(ahead) is called when the caller has to
  // wait, with the number of runs in front of it.
  acquire(o?: { signal?: AbortSignal; until?: number; onQueued?(ahead: number): void }): Promise<() => void>;
  active(): number;
  waiting(): number;
}

const MAX_TIMER = 2 ** 31 - 1;

interface Waiter {
  grant(): void;
}

export function createSlots(limit: () => number): Slots {
  let active = 0;
  const queue: Waiter[] = [];
  const cap = () => {
    const n = Math.floor(limit());
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };
  const releaser = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      active--;
      pump();
    };
  };
  const pump = () => {
    while (active < cap() && queue.length) {
      const w = queue.shift()!;
      active++;
      w.grant();
    }
  };
  return {
    active: () => active,
    waiting: () => queue.length,
    acquire(o = {}) {
      if (o.signal?.aborted) return Promise.reject(new SlotWaitError("cancelled"));
      if (o.until !== undefined && o.until <= Date.now()) return Promise.reject(new SlotWaitError("deadline"));
      if (active < cap() && !queue.length) {
        active++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
        };
        const leave = (reason: "cancelled" | "deadline") => {
          const i = queue.indexOf(w);
          if (i < 0) return; // already granted
          queue.splice(i, 1);
          cleanup();
          reject(new SlotWaitError(reason));
        };
        const onAbort = () => leave("cancelled");
        const w: Waiter = {
          grant() {
            cleanup();
            resolve(releaser());
          },
        };
        queue.push(w);
        o.signal?.addEventListener("abort", onAbort, { once: true });
        // setTimeout fires at once for a delay past 2^31-1 ms (~24.8 days): a far deadline re-arms instead.
        const arm = (until: number) => {
          const ms = until - Date.now();
          timer = ms > MAX_TIMER ? setTimeout(() => arm(until), MAX_TIMER) : setTimeout(() => leave("deadline"), Math.max(0, ms));
        };
        if (o.until !== undefined) arm(o.until);
        try {
          o.onQueued?.(queue.length - 1 + active);
        } catch {
          // a listener's failure never blocks the queue
        }
      });
    },
  };
}

// CONSOLE_RUNTIME_CONCURRENCY → a whole number from 1 to 16; anything else is the default, 1.
export function runtimeConcurrency(v: string | undefined): number {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= 16 && String(n) === String(v).trim() ? n : 1;
}
