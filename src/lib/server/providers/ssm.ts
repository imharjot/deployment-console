// Parameter Store provider: parameters' METADATA only — name, type, tier, version, KMS key, policies — from
// DescribeParameters (a read: it returns no values; 50 per page, at most 2,000 per region). Tags aren't in that list, so
// parameters are tagsUnread and the panel reads them (ListTagsForResource). This file never imports GetParameter(s):
// values reach a browser only through the audited Variables editor (aws.ts). Read-only: no actions. The mapper is pure
// (../../inventory/ssm.ts).
import "server-only";
import { DescribeParametersCommand, ListTagsForResourceCommand, SSMClient } from "@aws-sdk/client-ssm";
import { parseArn } from "../../inventory/arn.ts";
import { ssmDetail, ssmResult, type RawParameter } from "../../inventory/ssm.ts";
import { simSsm, simSsmTags } from "./mock/ssm.ts";
import { paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const ssm = perRegion((region) => new SSMClient(sdkConfig(region)), "ssm");
const CAP = 2_000;

async function fetchParameters(ctx: ProviderContext): Promise<RawParameter[]> {
  const c = ssm(ctx.region);
  return paged<RawParameter>({ ...ctx, cap: Math.min(ctx.cap, CAP) }, "ssm parameters", async (NextToken) => {
    const r = await c.send(new DescribeParametersCommand({ MaxResults: 50, NextToken }), t(ctx));
    return { items: r.Parameters, next: r.NextToken };
  }, { service: "ssm" });
}

export const ssmProvider: Provider = {
  id: "ssm",
  label: "Parameter Store",
  kinds: ["ssm-parameter"],
  scope: "regional",
  covers: ["ssm:parameter"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["ssm:DescribeParameters", "ssm:ListTagsForResource"],
  async discover(ctx) {
    const params = ctx.mock ? simSsm(ctx.region) : await fetchParameters(ctx);
    return ssmResult(params, { region: ctx.region, account: ctx.accountId, now: Date.now() });
  },
  // The metadata again (DescribeParameters for this one name) and its tags — never the value.
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return ssmDetail(r.key, simSsm(region).find((p) => p.ARN === r.key), simSsmTags(r.name));
    const c = ssm(region);
    const [meta, tags] = await Promise.all([
      c.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Option: "Equals", Values: [r.name] }] }), t(ctx)),
      softly(ctx, "ssm parameter tags", { service: "ssm" })(() => c.send(new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: r.name }), t(ctx))),
    ]);
    return ssmDetail(r.key, meta.Parameters?.[0], tags?.TagList);
  },
};
