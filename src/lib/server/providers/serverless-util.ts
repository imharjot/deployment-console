// Plumbing shared by the providers (serverless & messaging, and the coverage providers of wave B): SDK client settings
// per region, clients bounded by the console's SDK-call limiter, per-call timeouts bound to the discovery deadline,
// pagination with the per-type cap, sub-calls that survive partial denies, per-item enrichment within the time budget,
// input refusals, and the simulation's delays.
// No AWS SDK imports here — each provider imports (and declares) its own commands.
import "server-only";
import { LIMITS } from "../../config.ts";
import { enrichAll } from "../../work-queue.ts";
import type { EnrichState } from "../../inventory/types.ts";
import { limitedClient, type SdkClient } from "../aws-limiter.ts";
import { connectionCredentials } from "../connection-credentials.ts";
import { generation } from "../connection-state.ts";
import { HttpError, errText } from "../errors.ts";
import { deniedAction, type ProviderContext } from "./types.ts";

// SDK retries back off on throttling instead of failing. Writes that must not be repeated blindly pass a lower
// maxAttempts (F31: a retried write whose first attempt reached AWS may act twice). Credentials: the AWS connection's.
export const sdkConfig = (region: string, o: { maxAttempts?: number } = {}) => ({ region, retryMode: "adaptive" as const, maxAttempts: o.maxAttempts ?? 3, credentials: connectionCredentials });

// One client per region, built on first use, its send() bounded by the SDK-call limiter (aws-limiter.ts) under
// `service` (default: the client's own service id) and that region.
export function perRegion<T>(make: (region: string) => T, service?: string): (region: string) => T {
  const clients = new Map<string, T>();
  let born = generation();
  return (region) => {
    // Clients belong to one AWS connection: after a switch (connection-state.ts) the old ones refuse to send.
    if (generation() !== born) {
      clients.clear();
      born = generation();
    }
    let c = clients.get(region);
    if (!c) clients.set(region, (c = limited(make(region), service, region)));
    return c;
  };
}

// limitedClient for anything with a send(); other values pass through untouched.
const limited = <T,>(c: T, service: string | undefined, region: string): T =>
  c && typeof c === "object" && typeof (c as { send?: unknown }).send === "function" ? (limitedClient(c as unknown as SdkClient, service, region) as T) : c;

// Abort options for one SDK call: the usual 5 s (or `ms`), and never past the discovery deadline.
export const t = (ctx?: { signal?: AbortSignal }, ms: number = LIMITS.awsTimeoutMs) => ({
  abortSignal: ctx?.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
});

// All pages of a list call, stopping at ctx.cap items (noted on the map). `service`: the IAM prefix, for diagnostics.
export async function paged<T>(
  ctx: ProviderContext, what: string, page: (token: string | undefined) => Promise<{ items: T[] | undefined; next?: string }>, o: { service?: string } = {},
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.limit(() => page(token), { service: o.service });
    out.push(...(r.items ?? []));
    token = r.next || undefined;
    if (out.length >= ctx.cap && (token || out.length > ctx.cap)) {
      ctx.note(`${what}: showing the first ${ctx.cap.toLocaleString("en-US")}`);
      return out.slice(0, ctx.cap);
    }
  } while (token && !ctx.signal.aborted);
  return out;
}

const notFound = (e: unknown) => /NotFound|NoSuch|NonExistent/.test((e as { name?: string })?.name ?? "");
const LATE = Symbol("past the discovery time budget");

// Secondary calls stop this long after discovery starts, so the provider finishes inside the inventory's 25 s deadline
// with fewer details instead of timing out with nothing.
export const SOFT_BUDGET_MS = 15_000;
export const budget = () => Date.now() + SOFT_BUDGET_MS;

// A secondary call (tags, URL config, subscription attributes…) that must never fail discovery. A denied permission is
// noted once and that kind of call isn't tried again; "not found" is an answer (undefined); other errors are noted once.
// `until`: skip once past this time — checked when the call STARTS, not when it was requested (R18: calls queued
// behind the limiter used to pass the check and then all run after the budget). `limited: false` runs fn without
// ctx.limit (fn makes its own ctx.limit / paged() calls). `service`: the IAM prefix, for diagnostics.
export function softly(ctx: ProviderContext, label: string, opts: { limited?: boolean; until?: number; service?: string } = {}) {
  let denied = false;
  let noted = false;
  let late = false;
  const pastBudget = () => {
    if (!late && opts.until && Date.now() > opts.until) {
      ctx.note(`${label}: skipped for the rest (discovery time budget)`);
      late = true;
    }
    return late;
  };
  return async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (denied || late || ctx.signal.aborted) return undefined;
    const start = () => (pastBudget() ? Promise.reject(LATE) : fn());
    try {
      return await (opts.limited === false ? start() : ctx.limit(start, { service: opts.service }));
    } catch (e) {
      if (e === LATE || ctx.signal.aborted) return undefined;
      const action = deniedAction(e);
      if (action) {
        if (!denied) ctx.note(`${label} skipped: ${action} denied`);
        denied = true;
        return undefined;
      }
      if (notFound(e)) return undefined;
      if (!noted) ctx.note(`${label}: ${errText(e)}`);
      noted = true;
      return undefined;
    }
  };
}

// List, then enrich (R18): per-item reads for the first `max` items through a small worker pool (`concurrency`,
// default 4), each item checking the run's deadline and `until` when it STARTS. Never throws: denied, failed, skipped
// and capped items come back as their EnrichState (callers copy it into resource.enrichment[label]) and the map gets
// one note per kind. A denial stops further calls of that kind; "not found" is an answer (ok, undefined).
export async function enrich<T, R>(
  ctx: ProviderContext, items: T[], o: { label: string; max: number; until?: number; concurrency?: number }, fn: (item: T) => Promise<R>,
): Promise<{ results: (R | undefined)[]; state: EnrichState[] }> {
  let denied: string | undefined;
  let failed: unknown;
  const r = await enrichAll(items, { concurrency: o.concurrency ?? 4, until: o.until, signal: ctx.signal, max: o.max }, async (item) => {
    if (denied) throw Object.assign(new Error(`${denied} denied`), { name: "AccessDenied" });
    try {
      return await ctx.limit(() => fn(item));
    } catch (e) {
      if (notFound(e)) return undefined;
      if (!ctx.signal.aborted) {
        const action = deniedAction(e);
        if (action) denied ??= action;
        else failed ??= e;
      }
      throw e;
    }
  });
  const count = (n: number) => n.toLocaleString("en-US");
  if (r.capped) ctx.note(`${o.label} read for the first ${count(items.length - r.capped)} of ${count(items.length)}`);
  if (r.skippedForTime && !ctx.signal.aborted) ctx.note(`${o.label}: ${count(r.skippedForTime)} not read (discovery time budget)`);
  if (denied) ctx.note(`${o.label} skipped: ${denied} denied`);
  if (failed) ctx.note(`${o.label}: ${errText(failed)}`);
  return { results: r.results, state: r.state };
}

// Per-item details are fetched for the first `max` items only (N calls each); the rest keep what the list returned.
export function firstN<T>(ctx: ProviderContext, items: T[], max: number, what: string): T[] {
  if (items.length > max) ctx.note(`${what} read for the first ${max.toLocaleString("en-US")} of ${items.length.toLocaleString("en-US")}`);
  return items.slice(0, max);
}

// Refusals raised by plan()/run(): the runner turns them into HTTP errors the caller sees.
export const invalid = (msg: string) => new HttpError(400, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

// Own-property read of an input object (never trusts inherited keys).
export const own = <T>(o: unknown, k: string): T | undefined => (o && typeof o === "object" && Object.hasOwn(o, k) ? ((o as Record<string, unknown>)[k] as T) : undefined);

// Simulated actions take a moment, like the real APIs.
export const simDelay = (ms = 400) => new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * ms)));
