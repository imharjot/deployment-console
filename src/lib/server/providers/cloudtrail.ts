// CloudTrail provider (audit §6 A.2, the cloudtrail row): the trails whose home is this region (DescribeTrails with
// includeShadowTrails false lists a multi-region trail once, where it lives), whether each is logging and delivering
// (GetTrailStatus), and their tags (ListTags, 20 trails a call). A trail that isn't logging is an error; a delivery
// error is a warning. Links: its bucket, log group, SNS topic, role and KMS key. The mapping is pure
// (../../inventory/cloudtrail.ts).
//
// Discovery lists, hands the list to ctx.checkpoint, then reads status and tags per trail through enrich() (R18).
// No activity metrics. Read-only: no actions.
import "server-only";
import { CloudTrailClient, DescribeTrailsCommand, GetTrailStatusCommand, ListTagsCommand } from "@aws-sdk/client-cloudtrail";
import { parseArn } from "../../inventory/arn.ts";
import { ownTrails, statusRows, trailResults, type RawTrail, type RawTrailStatus, type TrailsInput } from "../../inventory/cloudtrail.ts";
import type { EnrichState, Resource, ResourceDetail } from "../../inventory/types.ts";
import { errText } from "../errors.ts";
import { simTrails } from "./mock/cloudtrail.ts";
import { budget, enrich, perRegion, sdkConfig, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const cloudtrail = perRegion((r) => new CloudTrailClient(sdkConfig(r)), "cloudtrail");
const STATUS_MAX = 300;
const TAG_BATCH = 20; // ListTags takes at most 20 trail ARNs

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || fallback;
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function realInput(ctx: ProviderContext, base: Pick<TrailsInput, "region" | "accountId" | "now">): Promise<TrailsInput> {
  const c = cloudtrail(ctx.region);
  const listed = (await ctx.limit(() => c.send(new DescribeTrailsCommand({ includeShadowTrails: false }), t(ctx)), { service: "cloudtrail" })).trailList ?? [];
  const trails: RawTrail[] = ownTrails(listed, ctx.region);
  ctx.checkpoint?.(trailResults({ ...base, trails }));
  const arns = trails.map((x) => x.TrailARN!);
  const until = budget();
  const [status, tags] = await Promise.all([
    enrich(ctx, arns, { label: "trail status", max: STATUS_MAX, until }, async (Name) => {
      const r = await c.send(new GetTrailStatusCommand({ Name }), t(ctx));
      return r as RawTrailStatus;
    }),
    enrich(ctx, chunk(arns, TAG_BATCH), { label: "trail tags", max: STATUS_MAX, until }, async (ResourceIdList) => {
      const r = await c.send(new ListTagsCommand({ ResourceIdList }), t(ctx));
      return Object.fromEntries((r.ResourceTagList ?? []).filter((x) => x.ResourceId).map((x) => [x.ResourceId!, Object.fromEntries((x.TagsList ?? []).filter((y) => y.Key).map((y) => [y.Key!, y.Value ?? ""]))]));
    }),
  ]);
  const statusMap: Record<string, RawTrailStatus | undefined> = {};
  const statusState: Record<string, EnrichState> = {};
  arns.forEach((arn, i) => {
    statusState[arn] = status.state[i];
    if (status.state[i] === "ok" && status.results[i]) statusMap[arn] = status.results[i];
  });
  const tagMap: Record<string, Record<string, string> | undefined> = {};
  const tagState: Record<string, EnrichState> = {};
  chunk(arns, TAG_BATCH).forEach((batch, i) => {
    for (const arn of batch) {
      tagState[arn] = tags.state[i];
      if (tags.state[i] === "ok") tagMap[arn] = tags.results[i]?.[arn] ?? {};
    }
  });
  return { ...base, trails, status: statusMap, statusState, tags: tagMap, tagState };
}

export const cloudtrailProvider: Provider = {
  id: "cloudtrail",
  label: "CloudTrail",
  kinds: ["cloudtrail-trail"],
  scope: "regional",
  covers: ["cloudtrail:trail"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["cloudtrail:DescribeTrails", "cloudtrail:GetTrailStatus", "cloudtrail:ListTags"],
  async discover(ctx) {
    const base = { region: ctx.region, accountId: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const sim = simTrails(ctx.region);
      return trailResults({ ...base, trails: sim.trails, status: sim.status, tags: sim.tags });
    }
    return trailResults(await realInput(ctx, base));
  },
  // Logging and delivery, as they are now.
  async detail(r, ctx): Promise<ResourceDetail> {
    let s: RawTrailStatus | undefined;
    if (ctx.mock) s = simTrails(regionOf(r, ctx.region)).status[r.key];
    else {
      try {
        s = await ctx.limit(() => cloudtrail(regionOf(r, ctx.region)).send(new GetTrailStatusCommand({ Name: r.key }), t(ctx)), { service: "cloudtrail" });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        const denied = deniedAction(e);
        return { key: r.key, sections: [{ title: "Logging and delivery", note: denied ? `The console's role can't read the trail's status (${denied}).` : `Status not loaded: ${errText(e)}` }] };
      }
    }
    return { key: r.key, sections: [s ? { title: "Logging and delivery", rows: statusRows(s) } : { title: "Logging and delivery", note: "This trail no longer exists." }] };
  },
};
