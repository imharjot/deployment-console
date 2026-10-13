// Other AWS resources provider: every other resource the account holds, as generic resources (kind "aws-resource"),
// so nothing is invisible (audit §6 B.1). Sources, layered:
// 1. Resource Explorer — ListIndexes, then ListResources with "region:<r>" on the region's default view (or the
//    aggregator's), at most 10,000 rows. IAM: resource-explorer-2:Search (ListResources has no action of its own).
// 2. The Tagging API (tag:GetResources, at most 5,000) when Resource Explorer has no index or view, or is denied.
//    Tagged resources only.
// 3. AWS Config (opt-in: inventory.catchAll.config) — SelectResourceConfig, with relationships.
// 4. Cloud Control (opt-in types: inventory.catchAll.cloudControlTypes) — ListResources per type. Each type's own list
//    permission (glue:GetDatabases for AWS::Glue::Database…) must be granted separately; it is documented, not generated.
// Plus one "region:global" pass in the home run (CC-7): IAM users and policies, CloudFront, budgets — Resource
// Explorer reports them from its us-east-1 index (or the aggregator).
// infer() folds rows that duplicate a first-class resource into it and counts sub-objects (B.4); the mapper is pure
// (../../inventory/catchall.ts). Read-only: no actions, no per-item reads.
import "server-only";
import { CloudControlClient, ListResourcesCommand as ListTypeResourcesCommand } from "@aws-sdk/client-cloudcontrol";
import { ConfigServiceClient, DescribeConfigurationRecorderStatusCommand, SelectResourceConfigCommand } from "@aws-sdk/client-config-service";
import { ListIndexesCommand, ListResourcesCommand, ResourceExplorer2Client, type ListResourcesCommandOutput } from "@aws-sdk/client-resource-explorer-2";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { CONFIG_SELECT, catchallResult, fromCloudControl, fromConfig, fromExplorer, fromTagging, type GenericRow, type RawExplorerResource } from "../../inventory/catchall.ts";
import type { Link } from "../../inventory/types.ts";
import { consoleConfig } from "../discovery.ts";
import { errText } from "../errors.ts";
import { simExplorer } from "./mock/catchall.ts";
import { perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const explorer = perRegion((r) => new ResourceExplorer2Client(sdkConfig(r)), "resource-explorer-2");
const tagging = perRegion((r) => new ResourceGroupsTaggingAPIClient(sdkConfig(r)), "tag");
const config = perRegion((r) => new ConfigServiceClient(sdkConfig(r)), "config");
const cloudControl = perRegion((r) => new CloudControlClient(sdkConfig(r)), "cloudcontrol");

const EXPLORER_CAP = 10_000;
const TAGGING_CAP = 5_000;
const CONFIG_CAP = 10_000;
// ListResources returns no NextToken when MaxResults is exactly 1,000 (documented), so pages are a little smaller.
const EXPLORER_PAGE = 500;
const GLOBAL_INDEX = "us-east-1"; // where Resource Explorer reports global resources
const CFN_TYPE = /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/;

// All pages of a list call up to `cap` rows (noted when cut).
async function pages<T>(ctx: ProviderContext, what: string, cap: number, service: string, page: (token: string | undefined) => Promise<{ items: T[] | undefined; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.limit(() => page(token), { service });
    out.push(...(r.items ?? []));
    token = r.next || undefined;
    if (out.length >= cap && token) {
      ctx.note(`catch-all: ${what} — showing the first ${cap.toLocaleString("en-US")}`);
      return out.slice(0, cap);
    }
  } while (token && !ctx.signal.aborted);
  return out;
}

type Index = { region: string; type: string };
const noView = (e: unknown) => /UnauthorizedException|ResourceNotFoundException|default view|no view/i.test(`${(e as { name?: string })?.name ?? ""} ${(e as Error)?.message ?? ""}`);

// Where to ask Resource Explorer about `region`: its own index, else the aggregator (which indexes every region).
function indexFor(indexes: Index[], region: string): string | undefined {
  if (indexes.some((i) => i.region === region)) return region;
  return indexes.find((i) => i.type.toUpperCase() === "AGGREGATOR")?.region;
}

// One Resource Explorer pass. Undefined (with a note) when there is no index or view to ask: the caller falls back to
// the Tagging API. A denial is noted and also falls back; other failures are thrown.
async function explore(ctx: ProviderContext, indexes: Index[] | undefined, region: string, filter: string): Promise<GenericRow[] | undefined> {
  if (!indexes) return undefined;
  const where = indexFor(indexes, region);
  if (!where) {
    ctx.note(`catch-all: Resource Explorer has no index for ${filter === "region:global" ? "global resources" : region} — using the Tagging API (tagged resources only)`);
    return undefined;
  }
  try {
    const c = explorer(where);
    const items = await pages<RawExplorerResource>(ctx, `resource explorer ${filter}`, EXPLORER_CAP, "resource-explorer-2", async (NextToken) => {
      const r: ListResourcesCommandOutput = await c.send(new ListResourcesCommand({ Filters: { FilterString: filter }, MaxResults: EXPLORER_PAGE, NextToken }), t(ctx, 10_000));
      return { items: r.Resources as RawExplorerResource[] | undefined, next: r.NextToken };
    });
    return fromExplorer(items);
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const denied = deniedAction(e);
    if (denied) ctx.note(`catch-all: ${denied} denied — using the Tagging API (tagged resources only)`);
    // 401 Unauthorized: the region has no default view, or the console may not use it (the view's resource policy).
    else if (noView(e)) ctx.note(`catch-all: Resource Explorer has no default view in ${where} that the console may use — using the Tagging API (tagged resources only)`);
    else throw e;
    return undefined;
  }
}

// The fallback: tagged resources in `region` (for the global pass, us-east-1's global ones). One listing per region
// and run, shared by the regional and the global pass when both ask us-east-1.
async function tagged(ctx: ProviderContext, region: string, global: boolean, seen: Map<string, Promise<GenericRow[]>>): Promise<GenericRow[]> {
  let all = seen.get(region);
  if (!all) {
    const c = tagging(region);
    all = pages(ctx, `tagging api in ${region}`, TAGGING_CAP, "tag", async (PaginationToken) => {
      const r = await c.send(new GetResourcesCommand({ ResourcesPerPage: 100, PaginationToken }), t(ctx, 10_000));
      return { items: r.ResourceTagMappingList, next: r.PaginationToken };
    }).then((items) => fromTagging(items, region));
    seen.set(region, all);
  }
  return (await all).filter((row) => (global ? row.region === "global" : row.region !== "global"));
}

async function fromAwsConfig(ctx: ProviderContext): Promise<{ rows: GenericRow[]; links: Link[] }> {
  const soft = softly(ctx, "catch-all: AWS Config", { service: "config" });
  const c = config(ctx.region);
  const status = await soft(() => c.send(new DescribeConfigurationRecorderStatusCommand({}), t(ctx)));
  if (!status) return { rows: [], links: [] };
  if (!status.ConfigurationRecordersStatus?.some((s) => s.recording)) {
    ctx.note(`catch-all: AWS Config isn't recording in ${ctx.region}`);
    return { rows: [], links: [] };
  }
  const results =
    (await soft(() =>
      pages(ctx, "aws config", CONFIG_CAP, "config", async (NextToken) => {
        const r = await c.send(new SelectResourceConfigCommand({ Expression: `${CONFIG_SELECT} WHERE awsRegion = '${ctx.region}'`, Limit: 100, NextToken }), t(ctx, 10_000));
        return { items: r.Results, next: r.NextToken };
      }),
    )) ?? [];
  return fromConfig(results, { region: ctx.region, account: ctx.accountId });
}

async function fromCloudControlTypes(ctx: ProviderContext, types: string[]): Promise<GenericRow[]> {
  const out: GenericRow[] = [];
  const c = cloudControl(ctx.region);
  for (const type of types) {
    if (!CFN_TYPE.test(type)) {
      ctx.note(`catch-all: "${type}" is not a CloudFormation type name — skipped`);
      continue;
    }
    const soft = softly(ctx, `catch-all: Cloud Control ${type}`, { service: "cloudcontrol" });
    const items = await soft(() =>
      pages(ctx, `cloud control ${type}`, ctx.cap, "cloudcontrol", async (NextToken) => {
        const r = await c.send(new ListTypeResourcesCommand({ TypeName: type, MaxResults: 100, NextToken }), t(ctx, 10_000));
        return { items: r.ResourceDescriptions, next: r.NextToken };
      }),
    );
    out.push(...fromCloudControl(type, items ?? [], { region: ctx.region, account: ctx.accountId }));
  }
  return out;
}

export const catchallProvider: Provider = {
  id: "catchall",
  label: "Other AWS resources",
  kinds: ["aws-resource"],
  scope: "regional",
  covers: [],
  ttlMs: 15 * 60_000,
  multiRegionMock: true,
  read: [
    "resource-explorer-2:ListIndexes", "resource-explorer-2:Search", "tag:GetResources", "config:DescribeConfigurationRecorderStatus", "config:SelectResourceConfig",
    "cloudformation:ListResources",
  ],
  async discover(ctx) {
    const now = Date.now();
    const home = ctx.home ?? ctx.regions?.[0] ?? ctx.region;
    const global = ctx.region === home; // the region:global pass runs once, in the home run (CC-7)
    if (ctx.mock) {
      const rows = [...fromExplorer(simExplorer(ctx.region, false)), ...(global ? fromExplorer(simExplorer(ctx.region, true)) : [])];
      return catchallResult(rows, { accountId: ctx.accountId, now });
    }
    let indexes: Index[] | undefined;
    try {
      const list = await pages(ctx, "resource explorer indexes", 1_000, "resource-explorer-2", async (NextToken) => {
        const r = await explorer(ctx.region).send(new ListIndexesCommand({ MaxResults: 100, NextToken }), t(ctx));
        return { items: r.Indexes, next: r.NextToken };
      });
      indexes = list.filter((i) => i.Region).map((i) => ({ region: i.Region!, type: String(i.Type ?? "LOCAL") }));
      if (!indexes.length) {
        ctx.note("catch-all: Resource Explorer isn't turned on in this account — using the Tagging API (tagged resources only)");
        indexes = undefined;
      }
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.note(`catch-all: Resource Explorer unavailable (${deniedAction(e) ? `${deniedAction(e)} denied` : errText(e)}) — using the Tagging API (tagged resources only)`);
    }
    const rows: GenericRow[] = [];
    const listed = new Map<string, Promise<GenericRow[]>>();
    rows.push(...((await explore(ctx, indexes, ctx.region, `region:${ctx.region}`)) ?? (await tagged(ctx, ctx.region, false, listed))));
    if (global) rows.push(...((await explore(ctx, indexes, GLOBAL_INDEX, "region:global")) ?? (await tagged(ctx, GLOBAL_INDEX, true, listed))));
    ctx.checkpoint?.(catchallResult(rows, { accountId: ctx.accountId, now }));
    const opts = consoleConfig().config.inventory?.catchAll;
    const links: Link[] = [];
    if (opts?.config) {
      const c = await fromAwsConfig(ctx);
      rows.push(...c.rows);
      links.push(...c.links);
    }
    if (opts?.cloudControlTypes?.length) rows.push(...(await fromCloudControlTypes(ctx, opts.cloudControlTypes)));
    return catchallResult(rows, { accountId: ctx.accountId, now, links });
  },
  // Generic rows are sent without props (slim): the panel's detail is what was listed, no further AWS call.
  async detail(r) {
    const tags = Object.entries(r.tags ?? {});
    return {
      key: r.key,
      sections: [
        { title: "Resource", rows: r.props, note: r.healthReason },
        ...(tags.length ? [{ title: "Tags", table: { columns: ["Key", "Value"], rows: tags.map(([k, v]) => [k, v]) } }] : []),
      ],
    };
  },
};
