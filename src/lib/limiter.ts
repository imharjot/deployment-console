// Keyed semaphores (pure): at most `perKey(key)` calls per key and `global` calls in all run at once. A call takes its
// key's slot first and the global slot second, and releases them in the opposite order, so no two calls can each hold
// what the other waits for. Both queues are first come, first served: a busy key can hold at most perKey(key) global
// slots or places in the global queue, so a quiet key is never starved by a busy one.
// Abort-aware: a call whose signal fires while it waits leaves the queue and rejects without ever starting.

export interface KeyedLimiter {
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  stats(): Record<string, { active: number; queued: number }>;
}

interface Waiter {
  grant: () => void;
}

type Semaphore = ReturnType<typeof semaphore>;

// A counting semaphore whose waiters can leave the queue.
function semaphore(limit: () => number) {
  let active = 0;
  const queue: Waiter[] = [];
  const pump = () => {
    while (queue.length && active < limit()) {
      active++;
      queue.shift()!.grant();
    }
  };
  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (active < limit() && !queue.length) {
        active++;
        return Promise.resolve(release);
      }
      return new Promise((resolve, reject) => {
        const w: Waiter = { grant: () => (signal?.removeEventListener("abort", onAbort), resolve(release)) };
        const onAbort = () => {
          const i = queue.indexOf(w);
          if (i < 0) return; // already granted
          queue.splice(i, 1);
          reject(abortReason(signal!));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(w);
      });
    },
  };
}

// What a cancelled wait rejects with: the signal's own reason (TimeoutError / AbortError), like the AWS SDK.
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

// The key's slot, then the global one; released global first. A wait cancelled half way gives back what it holds, and
// a signal that fires between the grant and the start still means the call never starts.
async function acquireBoth(key: Semaphore, global: Semaphore, signal: AbortSignal | undefined): Promise<() => void> {
  const releaseKey = await key.acquire(signal);
  try {
    const releaseGlobal = await global.acquire(signal);
    if (signal?.aborted) {
      releaseGlobal();
      throw abortReason(signal);
    }
    return () => {
      releaseGlobal();
      releaseKey();
    };
  } catch (e) {
    releaseKey();
    throw e;
  }
}

export function keyedLimiter(o: { global: number; perKey: (k: string) => number }): KeyedLimiter {
  const cap = (n: number) => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1);
  const global = semaphore(() => cap(o.global));
  const keys = new Map<string, { sem: Semaphore; waiting: number; running: number }>();
  const keyOf = (k: string) => {
    let e = keys.get(k);
    if (!e) keys.set(k, (e = { sem: semaphore(() => cap(o.perKey(k))), waiting: 0, running: 0 }));
    return e;
  };
  return {
    async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const k = keyOf(key);
      k.waiting++;
      const release = await acquireBoth(k.sem, global, signal).finally(() => k.waiting--);
      k.running++;
      try {
        return await fn();
      } finally {
        k.running--;
        release();
      }
    },
    stats() {
      const out: Record<string, { active: number; queued: number }> = {};
      for (const [k, e] of keys) if (e.running || e.waiting) out[k] = { active: e.running, queued: e.waiting };
      return out;
    },
  };
}
