// Athena provider: workgroups with where they write query results, their encryption and engine. ListWorkGroups (50 per
// page), checkpoint, then GetWorkGroup per workgroup through enrich() (R18, first 300). The default "primary" workgroup
// is hidden while it has no result location. Tags aren't read (tagsUnread, R01). Read-only: no actions, no activity.
// The mapper is pure (../../inventory/athena.ts).
import "server-only";
import { AthenaClient, GetWorkGroupCommand, ListWorkGroupsCommand } from "@aws-sdk/client-athena";
import { parseArn } from "../../inventory/arn.ts";
import { athenaDetail, athenaResult, type AthenaConfig, type RawWorkGroup } from "../../inventory/athena.ts";
import { simAthena } from "./mock/athena.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const athena = perRegion((region) => new AthenaClient(sdkConfig(region)), "athena");
const CONFIG_MAX = 300;

const getWorkGroup = async (region: string, name: string, ctx: ProviderContext) => (await athena(region).send(new GetWorkGroupCommand({ WorkGroup: name }), t(ctx))).WorkGroup;

async function fetchWorkGroups(ctx: ProviderContext): Promise<RawWorkGroup[]> {
  const list = await paged(ctx, "athena workgroups", async (NextToken) => {
    const r = await athena(ctx.region).send(new ListWorkGroupsCommand({ MaxResults: 50, NextToken }), t(ctx));
    return { items: r.WorkGroups, next: r.NextToken };
  }, { service: "athena" });
  const base = list.filter((w) => w.Name).map((w): RawWorkGroup => ({ Name: w.Name, State: w.State, Description: w.Description, CreationTime: w.CreationTime, EngineVersion: w.EngineVersion, enrichment: { config: "skipped" } }));
  ctx.checkpoint?.(athenaResult(base, { region: ctx.region, account: ctx.accountId }));
  const r = await enrich(ctx, base, { label: "athena workgroup configuration", max: CONFIG_MAX, until: budget() }, async (w) => (await getWorkGroup(ctx.region, w.Name!, ctx))?.Configuration as AthenaConfig | undefined);
  return base.map((w, i) => ({ ...w, ...(r.results[i] ? { config: r.results[i] } : {}), enrichment: { config: r.state[i] } }));
}

export const athenaProvider: Provider = {
  id: "athena",
  label: "Athena",
  kinds: ["athena-workgroup"],
  scope: "regional",
  covers: ["athena:workgroup"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["athena:ListWorkGroups", "athena:GetWorkGroup"],
  async discover(ctx) {
    const groups = ctx.mock ? simAthena(ctx.region) : await fetchWorkGroups(ctx);
    return athenaResult(groups, { region: ctx.region, account: ctx.accountId });
  },
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return athenaDetail(r.key, simAthena(region).find((w) => w.Name === r.name));
    const w = await getWorkGroup(region, r.name, ctx);
    return athenaDetail(r.key, w ? { Name: w.Name, State: w.State, Description: w.Description, CreationTime: w.CreationTime, config: w.Configuration as AthenaConfig | undefined } : undefined);
  },
};
