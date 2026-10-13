// Small helpers shared by the edge providers (S3, CloudFront, Route 53, Cloudflare): the concurrency/deadline wrapper
// their sources take, AWS call timeouts, and error formatting that never includes request details. The write settings
// and the titled form fields are shared with the compute providers' actions too.
import "server-only";
import { LIMITS } from "../../config.ts";
import type { Io } from "../../inventory/edge-s3.ts";
import type { Resource } from "../../inventory/types.ts";
import type { JsonSchema } from "../ops/types.ts";
import type { ProviderContext } from "./types.ts";

export const ioOf = (ctx: ProviderContext): Io => ({ limit: ctx.limit, signal: ctx.signal });

// SDK retry settings: back off on throttling instead of failing (Route 53 allows 5 requests/s per account).
export const retry = { retryMode: "adaptive" as const, maxAttempts: 3 };
// Writes are sent once (F31): a retry after a lost answer could act twice. A write cut off after it was sent is
// "outcome unknown" (the SDK-call limiter flags it for the mutation coordinator), never retried blindly.
export const once = { retryMode: "standard" as const, maxAttempts: 1 };
export const writeOpts = (ms: number = LIMITS.awsWriteTimeoutMs) => ({ abortSignal: AbortSignal.timeout(ms) });

// An input-schema property with the label people see on the form (F42); `description` stays the hint for agents.
// "x-echo": a field the confirming request copies from the dry run's `plan.echo` (the state the plan was made against,
// R04) — a form fills it from the plan instead of asking a person for it.
export const field = (s: JsonSchema & { title: string }): JsonSchema => s;

// Every SDK call: the usual 5 s, and never past the discovery deadline.
export const abortOf = (io?: Io) => ({
  abortSignal: io?.signal ? AbortSignal.any([io.signal, AbortSignal.timeout(LIMITS.awsTimeoutMs)]) : AbortSignal.timeout(LIMITS.awsTimeoutMs),
});

export const errName = (e: unknown) => (e as { name?: string })?.name ?? "";
export const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).replace(/\s+/g, " ").slice(0, 200);

export const propOf = (r: Resource, label: string) => r.props.find((p) => p.label === label)?.value;
export const idOf = (key: string) => key.split("/").pop() ?? key;
export const fmtTime = (t?: number) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");

// Runs fn over items with at most n in flight (for sources outside the shared AWS limit, like Cloudflare).
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}
