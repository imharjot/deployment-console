// Plumbing shared by the compute providers (ec2, asg, eks, apprunner, beanstalk, ecs-image): per-region SDK clients
// bounded by the console's SDK-call limiter, abortable calls under the discovery deadline, optional reads that degrade
// to a note, per-item enrichment within the time budget, and AWS tag maps.
import "server-only";
import { LIMITS } from "../../config.ts";
import { errText } from "../errors.ts";
import { perRegion } from "./serverless-util.ts";
import { deniedAction, type ProviderContext } from "./types.ts";

// The same client settings, enrichment queue and budget helpers as the serverless providers.
export { enrich, sdkConfig, softly, paged, budget } from "./serverless-util.ts";

// One client per region, created on first use, its send() bounded by the SDK-call limiter (service@region slots).
export function regional<C>(make: (region: string) => C, service?: string): (region: string) => C {
  return perRegion(make, service);
}

// Every call carries the discovery deadline (when there is one) and the console's per-call timeout.
export const abortOpts = (signal?: AbortSignal) => {
  const t = AbortSignal.timeout(LIMITS.awsTimeoutMs);
  return { abortSignal: signal ? AbortSignal.any([signal, t]) : t };
};
export const call = <T,>(ctx: ProviderContext, fn: (o: { abortSignal: AbortSignal }) => Promise<T>, o: { service?: string } = {}) =>
  ctx.limit(() => fn(abortOpts(ctx.signal)), { service: o.service });

// A secondary read (Elastic IPs, status checks, tags…) that may be denied or fail without losing the provider's
// resources: say what is missing and carry on with the fallback.
export async function optional<T>(ctx: ProviderContext, what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const denied = deniedAction(e);
    ctx.note(denied ? `${what}: not shown — the console's role lacks ${denied}` : `${what}: not shown (${errText(e)})`);
    return fallback;
  }
}

export const tagMap = (tags?: { Key?: string; Value?: string; key?: string; value?: string }[]): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((x) => [x.Key ?? x.key ?? "", x.Value ?? x.value ?? ""]).filter(([k]) => k));

export const ms = (d?: Date) => (d ? d.getTime() : undefined);
