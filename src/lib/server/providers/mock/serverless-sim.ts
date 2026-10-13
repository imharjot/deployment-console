// Helpers for the simulated serverless estate (./lambda.ts, ./sqs.ts, …): state kept on globalThis (Next bundles the
// routes and the sampler separately — one state means an action is visible to the next discovery), time constants,
// deterministic numbers for charts, and AWS's timestamp formats. No `server-only`, so node:test can load the mocks.
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function simState<T>(key: string, init: () => T): T {
  const g = globalThis as Record<string, unknown>;
  return (g[key] ??= init()) as T;
}

// FNV-1a: stable pseudo-random numbers from names.
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Lambda writes LastModified as "2026-09-27T10:00:00.000+0000".
export const lambdaTime = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");

// A deterministic metric series ending now: `points` buckets of `stepMs`, values around `level` (0 = none).
export function series(seed: string, now: number, points: number, stepMs: number, level: number): [number, number][] {
  const end = Math.floor(now / stepMs) * stepMs;
  return Array.from({ length: points }, (_, i) => {
    const t = end - (points - 1 - i) * stepMs;
    const jitter = (hash(`${seed}:${t}`) % 1000) / 1000; // 0..1
    const daily = 0.6 + 0.4 * Math.sin(((t % DAY) / DAY) * 2 * Math.PI - Math.PI / 2); // quieter at night
    return [t, level <= 0 ? 0 : Math.round(level * daily * (0.5 + jitter))];
  });
}

// Short random ids (message ids, execution names) for simulated calls.
export const simId = () => `${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
