// IAM roles provider: every IAM role with its trust policy, attached and inline policy NAMES, permissions boundary,
// instance profiles and last use, from ONE paged GetAccountAuthorizationDetails call (Filter Role, 1,000 per page,
// Marker). Per-role GetRole calls against the far-away IAM endpoint can't finish inside the discovery deadline (CC-9).
// Global: one run, in us-east-1, resources in region "global"; the SDK-call limiter allows one IAM call at a time.
// The (slimmed) result is cached on globalThis per account, so detail() renders it without another call. Service-linked
// and reserved roles are hidden. Read-only: no actions. The mapper is pure (../../inventory/iam.ts).
import "server-only";
import { GetAccountAuthorizationDetailsCommand, IAMClient } from "@aws-sdk/client-iam";
import { iamDetail, iamResult, slimRole, type RawRole } from "../../inventory/iam.ts";
import { idleDaysOf } from "../../inventory/idle.ts";
import { consoleConfig } from "../discovery.ts";
import { simRoles } from "./mock/iam.ts";
import { paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const iam = perRegion((region) => new IAMClient(sdkConfig(region)), "iam");
const PAGE = 1_000;
const CALL_MS = 15_000; // one page carries up to 1,000 roles with their policies: allow more than the usual 5 s

// The last read per account (detail() serves it). Shared across Next bundles: discovery may run in the instrumentation
// bundle while the detail route runs in another.
type RoleCache = Map<string, { at: number; roles: Map<string, RawRole> }>;
const cache = (): RoleCache => ((globalThis as { __consoleIamRoles?: RoleCache }).__consoleIamRoles ??= new Map());
const cacheKey = (account: string | undefined) => account ?? "-";

async function fetchRoles(ctx: ProviderContext): Promise<RawRole[]> {
  const c = iam(ctx.region);
  const roles = await paged<RawRole>(ctx, "iam roles", async (Marker) => {
    const r = await c.send(new GetAccountAuthorizationDetailsCommand({ Filter: ["Role"], MaxItems: PAGE, Marker }), t(ctx, CALL_MS));
    return { items: r.RoleDetailList as RawRole[] | undefined, next: r.IsTruncated ? r.Marker : undefined };
  }, { service: "iam" });
  return roles.map(slimRole); // inline policy documents never leave this function
}

export const iamProvider: Provider = {
  id: "iam",
  label: "IAM roles",
  kinds: ["iam-role"],
  scope: "global",
  homeRegion: "us-east-1",
  covers: ["iam:role", "iam:instance-profile"],
  ttlMs: 30 * 60_000,
  multiRegionMock: true,
  read: ["iam:GetAccountAuthorizationDetails"],
  async discover(ctx) {
    const idleDays = idleDaysOf(consoleConfig().config.inventory?.idleDays);
    const roles = ctx.mock ? simRoles() : await fetchRoles(ctx);
    if (!ctx.mock) cache().set(cacheKey(ctx.accountId), { at: Date.now(), roles: new Map(roles.filter((r) => r.Arn).map((r) => [r.Arn!, r])) });
    return iamResult(roles, { now: Date.now(), idleDays, account: ctx.accountId });
  },
  // No AWS call: the role as the last discovery read it (CC-9).
  async detail(r, ctx) {
    const raw = ctx.mock ? simRoles().find((x) => x.Arn === r.key) : cache().get(cacheKey(ctx.accountId))?.roles.get(r.key);
    return iamDetail(r.key, raw);
  },
};
