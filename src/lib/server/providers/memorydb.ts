// MemoryDB provider: MemoryDB clusters with their shards, endpoint, network and encryption. Lists DescribeClusters
// (shard details included), hands that to ctx.checkpoint, then reads tags per cluster through enrich() (R18, first
// 200; unread tags: tagsUnread, R01). No activity: the dimension set isn't verified (A.2 P2, CC-19). Read-only: no
// actions. The mapping is pure (../../inventory/caches.ts).
import "server-only";
import { DescribeClustersCommand, ListTagsCommand, MemoryDBClient } from "@aws-sdk/client-memorydb";
import { parseArn } from "../../inventory/arn.ts";
import { memorydbDetail, memorydbResult, type RawMemoryDbCluster } from "../../inventory/caches.ts";
import { simLastUse, simMemoryDb } from "./mock/memorydb.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const memorydb = perRegion((region) => new MemoryDBClient(sdkConfig(region)), "memorydb");
const PAGE = 100;
const TAGS_MAX = 200;

const listClusters = (ctx: ProviderContext, region: string, name?: string) =>
  paged(ctx, "memorydb clusters", async (NextToken) => {
    const r = await memorydb(region).send(new DescribeClustersCommand({ ...(name ? { ClusterName: name } : {}), ShowShardDetails: true, MaxResults: PAGE, NextToken }), t(ctx));
    return { items: r.Clusters as RawMemoryDbCluster[] | undefined, next: r.NextToken };
  }, { service: "memorydb" });

const tagsOf = async (ctx: ProviderContext, region: string, arn: string) => (await memorydb(region).send(new ListTagsCommand({ ResourceArn: arn }), t(ctx))).TagList ?? [];

async function fetchClusters(ctx: ProviderContext): Promise<RawMemoryDbCluster[]> {
  const region = ctx.region;
  const base = (await listClusters(ctx, region)).map((c): RawMemoryDbCluster => ({ ...c, enrichment: { tags: "skipped" } }));
  ctx.checkpoint?.(memorydbResult(base, { region, account: ctx.accountId, now: Date.now() }));
  const r = await enrich(ctx, base, { label: "memorydb tags", max: TAGS_MAX, until: budget() }, (c) => tagsOf(ctx, region, c.ARN!));
  return base.map((c, i) => ({ ...c, ...(r.state[i] === "ok" ? { tags: r.results[i] ?? [] } : {}), enrichment: { tags: r.state[i] } }));
}

export const memorydbProvider: Provider = {
  id: "memorydb",
  label: "MemoryDB",
  kinds: ["memorydb-cluster"],
  scope: "regional",
  covers: ["memorydb:cluster"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["memorydb:DescribeClusters", "memorydb:ListTags"],
  async discover(ctx) {
    const o = { region: ctx.region, account: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const out = memorydbResult(simMemoryDb(ctx.region), o);
      for (const r of out.resources) r.lastActivityAt = simLastUse();
      return out;
    }
    return memorydbResult(await fetchClusters(ctx), o);
  },
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return memorydbDetail(r.key, simMemoryDb(region).find((c) => c.ARN === r.key));
    let c: RawMemoryDbCluster | undefined;
    try {
      c = (await listClusters(ctx, region, r.name))[0];
    } catch (e) {
      if (!/NotFound/.test((e as { name?: string })?.name ?? "")) throw e;
    }
    if (!c) return memorydbDetail(r.key, undefined);
    const tags = await softly(ctx, "memorydb tags", { service: "memorydb" })(() => tagsOf(ctx, region, r.key));
    return memorydbDetail(r.key, { ...c, ...(tags ? { tags } : {}), enrichment: { tags: tags ? "ok" : "error" } });
  },
};
