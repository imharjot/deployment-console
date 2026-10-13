// AppSync provider: GraphQL (and merged) APIs with the hosts they answer on and what their data sources reach.
// ListGraphqlApis (25 per page; tags come with it), checkpoint, then ListDataSources per API through enrich() (R18,
// first 300 APIs, up to 4 pages of 25 each). ListApiKeys is never called: API keys are bearer credentials. Read-only:
// no actions, no activity series. The mapper is pure (../../inventory/app-platforms.ts).
import "server-only";
import { AppSyncClient, ListDataSourcesCommand, ListGraphqlApisCommand } from "@aws-sdk/client-appsync";
import { parseArn } from "../../inventory/arn.ts";
import { appsyncDetail, appsyncResult, type RawDataSource, type RawGraphqlApi } from "../../inventory/app-platforms.ts";
import { simAppsync } from "./mock/appsync.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const appsync = perRegion((region) => new AppSyncClient(sdkConfig(region)), "appsync");
const SOURCES_MAX = 300;
const SOURCE_PAGES = 4;

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;
const notFound = (e: unknown) => /NotFound/.test((e as { name?: string })?.name ?? "");

// The data-source fields the mapper reads (HTTP authorization settings and metrics settings stay out).
const pick = (d: RawDataSource & Record<string, unknown>): RawDataSource => ({
  dataSourceArn: d.dataSourceArn, name: d.name, type: d.type, serviceRoleArn: d.serviceRoleArn, dynamodbConfig: d.dynamodbConfig, lambdaConfig: d.lambdaConfig,
  elasticsearchConfig: d.elasticsearchConfig, openSearchServiceConfig: d.openSearchServiceConfig, httpConfig: d.httpConfig ? { endpoint: d.httpConfig.endpoint } : undefined,
  relationalDatabaseConfig: d.relationalDatabaseConfig, eventBridgeConfig: d.eventBridgeConfig,
});

async function dataSources(region: string, apiId: string, ctx: ProviderContext): Promise<{ dataSources: RawDataSource[]; more: boolean }> {
  const out: RawDataSource[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < SOURCE_PAGES; page++) {
    const r = await appsync(region).send(new ListDataSourcesCommand({ apiId, maxResults: 25, nextToken }), t(ctx));
    out.push(...(r.dataSources ?? []).map((d) => pick(d as RawDataSource & Record<string, unknown>)));
    nextToken = r.nextToken;
    if (!nextToken) break;
  }
  return { dataSources: out, more: !!nextToken };
}

// ListGraphqlApis' fields the mapper reads (owner contact and limits stay out).
const api = (a: RawGraphqlApi & Record<string, unknown>): RawGraphqlApi => ({
  name: a.name, apiId: a.apiId, arn: a.arn, apiType: a.apiType, visibility: a.visibility, uris: a.uris, dns: a.dns, tags: a.tags ?? {}, authenticationType: a.authenticationType,
  userPoolConfig: a.userPoolConfig, lambdaAuthorizerConfig: a.lambdaAuthorizerConfig, additionalAuthenticationProviders: a.additionalAuthenticationProviders, logConfig: a.logConfig,
  xrayEnabled: a.xrayEnabled, wafWebAclArn: a.wafWebAclArn, mergedApiExecutionRoleArn: a.mergedApiExecutionRoleArn,
});

async function fetchApis(ctx: ProviderContext): Promise<RawGraphqlApi[]> {
  const list = await paged(ctx, "appsync APIs", async (nextToken) => {
    const r = await appsync(ctx.region).send(new ListGraphqlApisCommand({ maxResults: 25, nextToken }), t(ctx));
    return { items: r.graphqlApis, next: r.nextToken };
  }, { service: "appsync" });
  const base = list.filter((a) => a.apiId && a.arn).map((a): RawGraphqlApi => ({ ...api(a as RawGraphqlApi & Record<string, unknown>), enrichment: { dataSources: "skipped" } }));
  ctx.checkpoint?.(appsyncResult(base, { region: ctx.region, account: ctx.accountId }));
  const r = await enrich(ctx, base, { label: "appsync data sources", max: SOURCES_MAX, until: budget() }, (a) => dataSources(ctx.region, a.apiId!, ctx));
  return base.map((a, i) => {
    const got = r.results[i];
    return r.state[i] === "ok" ? { ...a, dataSources: got?.dataSources ?? [], dataSourcesMore: !!got?.more, enrichment: { dataSources: "ok" } } : { ...a, enrichment: { dataSources: r.state[i] } };
  });
}

export const appsyncProvider: Provider = {
  id: "appsync",
  label: "AppSync",
  kinds: ["appsync-api"],
  scope: "regional",
  covers: ["appsync:apis"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["appsync:ListGraphqlApis", "appsync:ListDataSources"],
  async discover(ctx) {
    return appsyncResult(ctx.mock ? simAppsync(ctx.region) : await fetchApis(ctx), { region: ctx.region, account: ctx.accountId });
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return appsyncDetail(r.key, simAppsync(region).find((a) => a.arn === r.key));
    const apiId = parseArn(r.key)?.id ?? r.aliases?.[0];
    if (!apiId) return appsyncDetail(r.key, undefined);
    // The data sources, read again (no GetGraphqlApi: the hosts come from discovery).
    try {
      const d = await dataSources(region, apiId, ctx);
      const uri = (h: string | undefined, scheme: string) => (h ? `${scheme}://${h}/graphql` : undefined);
      const hosts = r.endpoints ?? [];
      return appsyncDetail(r.key, {
        apiId, arn: r.key, dataSources: d.dataSources, dataSourcesMore: d.more,
        uris: { GRAPHQL: uri(hosts.find((h) => h.includes(".appsync-api.")), "https") ?? "", REALTIME: uri(hosts.find((h) => h.includes(".appsync-realtime-api.")), "wss") ?? "" },
      });
    } catch (e) {
      if (notFound(e)) return appsyncDetail(r.key, undefined);
      throw e;
    }
  },
};
