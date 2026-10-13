// OpenSearch provider: OpenSearch Service domains (OpenSearch and legacy Elasticsearch engines) with their endpoints,
// VPC, nodes, encryption and log publishing. ListDomainNames, then DescribeDomains at most 5 names per call (the API's
// limit); hands that to ctx.checkpoint, then reads tags per domain through enrich() (R18, first 200; unread tags:
// tagsUnread, R01). Activity: searches and indexing per domain (AWS/ES with the documented {DomainName, ClientId} set;
// both required, R20). Read-only: no actions. The mapping is pure (../../inventory/opensearch.ts).
import "server-only";
import { DescribeDomainsCommand, ListDomainNamesCommand, ListTagsCommand, OpenSearchClient } from "@aws-sdk/client-opensearch";
import { parseArn } from "../../inventory/arn.ts";
import { opensearchDetail, opensearchResult, type RawDomain } from "../../inventory/opensearch.ts";
import { simDomains, simLastSearch } from "./mock/opensearch.ts";
import { budget, enrich, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { ActivitySpec, Provider, ProviderContext } from "./types.ts";

const os = perRegion((region) => new OpenSearchClient(sdkConfig(region)), "es");
const BATCH = 5; // DescribeDomains: at most 5 names per call
const TAGS_MAX = 200;

async function describe(ctx: ProviderContext, region: string, names: string[]): Promise<RawDomain[]> {
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += BATCH) batches.push(names.slice(i, i + BATCH));
  const pages = await Promise.all(batches.map((DomainNames) => ctx.limit(() => os(region).send(new DescribeDomainsCommand({ DomainNames }), t(ctx)), { service: "es" })));
  return pages.flatMap((p) => (p.DomainStatusList ?? []) as RawDomain[]);
}

const tagsOf = async (ctx: ProviderContext, region: string, arn: string) => (await os(region).send(new ListTagsCommand({ ARN: arn }), t(ctx))).TagList ?? [];

async function fetchDomains(ctx: ProviderContext): Promise<RawDomain[]> {
  const region = ctx.region;
  const listed = await ctx.limit(() => os(region).send(new ListDomainNamesCommand({}), t(ctx)), { service: "es" });
  let names = (listed.DomainNames ?? []).map((d) => d.DomainName).filter((n): n is string => !!n);
  if (names.length > ctx.cap) {
    ctx.note(`opensearch domains: showing the first ${ctx.cap.toLocaleString("en-US")}`);
    names = names.slice(0, ctx.cap);
  }
  const base = (await describe(ctx, region, names)).map((d): RawDomain => ({ ...d, enrichment: { tags: "skipped" } }));
  ctx.checkpoint?.(opensearchResult(base, { region, account: ctx.accountId, now: Date.now() }));
  const r = await enrich(ctx, base, { label: "opensearch domain tags", max: TAGS_MAX, until: budget() }, (d) => tagsOf(ctx, region, d.ARN!));
  return base.map((d, i) => ({ ...d, ...(r.state[i] === "ok" ? { tags: r.results[i] ?? [] } : {}), enrichment: { tags: r.state[i] } }));
}

export const opensearchProvider: Provider = {
  id: "opensearch",
  label: "OpenSearch",
  kinds: ["opensearch-domain"],
  scope: "regional",
  covers: ["es:domain"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["es:ListDomainNames", "es:DescribeDomains", "es:ListTags"],
  async discover(ctx) {
    const o = { region: ctx.region, account: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const out = opensearchResult(simDomains(ctx.region), o);
      for (const r of out.resources) r.lastActivityAt = simLastSearch();
      return out;
    }
    return opensearchResult(await fetchDomains(ctx), o);
  },
  // A.2 #15: AWS/ES publishes per domain with the account as ClientId. Searches and indexing both show use (R20).
  activity: (r) => {
    const p = parseArn(r.key);
    if (!p?.account) return [];
    const dims = { DomainName: r.name, ClientId: p.account };
    const spec = (metric: string, label: string): ActivitySpec => ({ namespace: "AWS/ES", metric, dims, stat: "Sum", label, region: p.region || undefined, required: true });
    return [spec("SearchRate", "searches per day (idle check)"), spec("IndexingRate", "documents indexed per day (idle check)")];
  },
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return opensearchDetail(r.key, simDomains(region).find((d) => d.ARN === r.key));
    let d: RawDomain | undefined;
    try {
      d = (await describe(ctx, region, [r.name]))[0];
    } catch (e) {
      if (!/NotFound/.test((e as { name?: string })?.name ?? "")) throw e;
    }
    if (!d) return opensearchDetail(r.key, undefined);
    const tags = await softly(ctx, "opensearch domain tags", { service: "es" })(() => tagsOf(ctx, region, r.key));
    return opensearchDetail(r.key, { ...d, ...(tags ? { tags } : {}), enrichment: { tags: tags ? "ok" : "error" } });
  },
};
