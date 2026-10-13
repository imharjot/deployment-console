// ElastiCache Serverless provider: serverless caches (Valkey, Redis OSS, Memcached) with their endpoints, usage limits,
// network and encryption. Lists DescribeServerlessCaches (100 per page), hands that to ctx.checkpoint, then reads tags
// per cache through enrich() (R18, first 200; unread tags: tagsUnread, R01). Resource Explorer doesn't index serverless
// caches, so it covers nothing. No activity (no verified dimension set yet). Read-only: no actions. The mapping is
// pure (../../inventory/caches.ts).
import "server-only";
import { DescribeServerlessCachesCommand, ElastiCacheClient, ListTagsForResourceCommand } from "@aws-sdk/client-elasticache";
import { parseArn } from "../../inventory/arn.ts";
import { serverlessCacheDetail, serverlessCacheResult, type RawServerlessCache } from "../../inventory/caches.ts";
import { simLastUse, simServerlessCaches } from "./mock/elasticache-serverless.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const elasticache = perRegion((region) => new ElastiCacheClient(sdkConfig(region)), "elasticache");
const PAGE = 100;
const TAGS_MAX = 200;

const listCaches = (ctx: ProviderContext, region: string, name?: string) =>
  paged(ctx, "elasticache serverless caches", async (NextToken) => {
    const r = await elasticache(region).send(new DescribeServerlessCachesCommand({ ...(name ? { ServerlessCacheName: name } : {}), MaxResults: PAGE, NextToken }), t(ctx));
    return { items: r.ServerlessCaches as RawServerlessCache[] | undefined, next: r.NextToken };
  }, { service: "elasticache" });

const tagsOf = async (ctx: ProviderContext, region: string, arn: string) => (await elasticache(region).send(new ListTagsForResourceCommand({ ResourceName: arn }), t(ctx))).TagList ?? [];

async function fetchCaches(ctx: ProviderContext): Promise<RawServerlessCache[]> {
  const region = ctx.region;
  const base = (await listCaches(ctx, region)).map((c): RawServerlessCache => ({ ...c, enrichment: { tags: "skipped" } }));
  ctx.checkpoint?.(serverlessCacheResult(base, { region, account: ctx.accountId, now: Date.now() }));
  const r = await enrich(ctx, base, { label: "elasticache serverless tags", max: TAGS_MAX, until: budget() }, (c) => tagsOf(ctx, region, c.ARN!));
  return base.map((c, i) => ({ ...c, ...(r.state[i] === "ok" ? { tags: r.results[i] ?? [] } : {}), enrichment: { tags: r.state[i] } }));
}

export const elasticacheServerlessProvider: Provider = {
  id: "elasticache-serverless",
  label: "ElastiCache Serverless",
  kinds: ["elasticache-serverless"],
  scope: "regional",
  covers: [], // Resource Explorer doesn't index elasticache:serverlesscache (CC-8)
  ttlMs: 2 * 60_000,
  multiRegionMock: true,
  read: ["elasticache:DescribeServerlessCaches", "elasticache:ListTagsForResource"],
  async discover(ctx) {
    const o = { region: ctx.region, account: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const out = serverlessCacheResult(simServerlessCaches(ctx.region), o);
      for (const r of out.resources) r.lastActivityAt = simLastUse();
      return out;
    }
    return serverlessCacheResult(await fetchCaches(ctx), o);
  },
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return serverlessCacheDetail(r.key, simServerlessCaches(region).find((c) => c.ARN === r.key));
    let c: RawServerlessCache | undefined;
    try {
      c = (await listCaches(ctx, region, r.name))[0];
    } catch (e) {
      if (!/NotFound/.test((e as { name?: string })?.name ?? "")) throw e;
    }
    if (!c) return serverlessCacheDetail(r.key, undefined);
    const tags = await softly(ctx, "elasticache serverless tags", { service: "elasticache" })(() => tagsOf(ctx, region, r.key));
    return serverlessCacheDetail(r.key, { ...c, ...(tags ? { tags } : {}), enrichment: { tags: tags ? "ok" : "error" } });
  },
};
