// Redshift provider: provisioned clusters (DescribeClusters, 100 per page, tags included) and Redshift Serverless
// workgroups (ListWorkgroups) with their namespaces (ListNamespaces), both 100 per page. Serverless is read softly: a
// region without it, or a denied read, leaves the provisioned clusters on the map with a note (any other failure fails
// the run, so the last good list is kept). Lists only — the checkpoint is the result. Workgroups' tags aren't read
// (tagsUnread, R01). Activity: connections per provisioned cluster (required, R20); none for workgroups (no documented
// single-dimension series). Read-only: no actions. The mapping is pure (../../inventory/redshift.ts).
import "server-only";
import { DescribeClustersCommand, RedshiftClient } from "@aws-sdk/client-redshift";
import { ListNamespacesCommand, ListWorkgroupsCommand, RedshiftServerlessClient } from "@aws-sdk/client-redshift-serverless";
import { parseArn } from "../../inventory/arn.ts";
import { clusterDetail, redshiftResult, workgroupDetail, type RawNamespace, type RawRedshiftCluster, type RawWorkgroup, type RedshiftInput } from "../../inventory/redshift.ts";
import { classifyError } from "../../inventory/schedule.ts";
import type { EnrichState } from "../../inventory/types.ts";
import { errText } from "../errors.ts";
import { simClusters, simLastQuery, simNamespaces, simWorkgroups } from "./mock/redshift.ts";
import { paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const redshift = perRegion((region) => new RedshiftClient(sdkConfig(region)), "redshift");
const serverless = perRegion((region) => new RedshiftServerlessClient(sdkConfig(region)), "redshift-serverless");
const PAGE = 100;

const listClusters = (ctx: ProviderContext, region: string, id?: string) =>
  paged(ctx, "redshift clusters", async (Marker) => {
    const r = await redshift(region).send(new DescribeClustersCommand({ ...(id ? { ClusterIdentifier: id } : { MaxRecords: PAGE }), Marker }), t(ctx));
    return { items: r.Clusters as RawRedshiftCluster[] | undefined, next: r.Marker };
  }, { service: "redshift" });

// Serverless is read softly only where that is the truth: a denial, or a region without Redshift Serverless, leaves the
// provisioned clusters with a note. Any other failure fails the run, so the inventory keeps the last good list rather
// than a complete-looking run without the workgroups (which would start their deletion confirmation).
async function listWorkgroups(ctx: ProviderContext, region: string): Promise<RawWorkgroup[] | undefined> {
  try {
    return await paged(ctx, "redshift serverless workgroups", async (nextToken) => {
      const r = await serverless(region).send(new ListWorkgroupsCommand({ maxResults: PAGE, nextToken }), t(ctx));
      return { items: r.workgroups as RawWorkgroup[] | undefined, next: r.nextToken };
    }, { service: "redshift-serverless" });
  } catch (e) {
    if (ctx.signal.aborted) return undefined;
    const action = deniedAction(e);
    if (action) ctx.note(`redshift serverless workgroups skipped: ${action} denied`);
    else if (classifyError(e, { home: !!ctx.home && region === ctx.home }) === "skipped") ctx.note("redshift serverless: not offered in this region");
    else throw e;
    return undefined;
  }
}

async function listNamespaces(ctx: ProviderContext, region: string): Promise<{ items?: RawNamespace[]; state: EnrichState }> {
  try {
    const items = await paged(ctx, "redshift serverless namespaces", async (nextToken) => {
      const r = await serverless(region).send(new ListNamespacesCommand({ maxResults: PAGE, nextToken }), t(ctx));
      return { items: r.namespaces as RawNamespace[] | undefined, next: r.nextToken };
    }, { service: "redshift-serverless" });
    return { items, state: "ok" };
  } catch (e) {
    if (ctx.signal.aborted) return { state: "skipped" };
    const action = deniedAction(e);
    ctx.note(action ? `redshift serverless namespaces skipped: ${action} denied` : `redshift serverless namespaces: ${errText(e)}`);
    return { state: action ? "denied" : "error" };
  }
}

async function fetchRedshift(ctx: ProviderContext): Promise<RedshiftInput> {
  const region = ctx.region;
  const [clusters, workgroups] = await Promise.all([listClusters(ctx, region), listWorkgroups(ctx, region)]);
  const ns = workgroups?.length ? await listNamespaces(ctx, region) : { items: [], state: "ok" as EnrichState };
  const input: RedshiftInput = { clusters, workgroups, namespaces: ns.items, namespacesState: ns.state };
  ctx.checkpoint?.(redshiftResult(input, { region, account: ctx.accountId, now: Date.now() })); // lists only: the checkpoint is the result
  return input;
}

export const redshiftProvider: Provider = {
  id: "redshift",
  label: "Redshift",
  kinds: ["redshift-cluster", "redshift-workgroup"],
  scope: "regional",
  covers: ["redshift:cluster"], // Resource Explorer doesn't index redshift-serverless (CC-8)
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["redshift:DescribeClusters", "redshift-serverless:ListWorkgroups", "redshift-serverless:ListNamespaces"],
  async discover(ctx) {
    const o = { region: ctx.region, account: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const out = redshiftResult({ clusters: simClusters(ctx.region), workgroups: simWorkgroups(ctx.region), namespaces: simNamespaces(ctx.region), namespacesState: "ok" }, o);
      for (const r of out.resources) r.lastActivityAt = simLastQuery(r.name);
      return out;
    }
    return redshiftResult(await fetchRedshift(ctx), o);
  },
  // A.2 P2: AWS/Redshift DatabaseConnections per ClusterIdentifier (R20: the series that shows use).
  activity: (r) =>
    r.kind === "redshift-cluster"
      ? [{ namespace: "AWS/Redshift", metric: "DatabaseConnections", dims: { ClusterIdentifier: r.name }, stat: "Maximum", label: "peak connections per day (idle check)", region: parseArn(r.key)?.region || undefined, required: true }]
      : [],
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (r.kind === "redshift-workgroup") {
      const pick = (ws: RawWorkgroup[] | undefined, ns: RawNamespace[] | undefined) => {
        const w = ws?.find((x) => x.workgroupArn === r.key || x.workgroupName === r.name);
        return workgroupDetail(r.key, w, ns?.find((n) => n.namespaceName === w?.namespaceName));
      };
      if (ctx.mock) return pick(simWorkgroups(region), simNamespaces(region));
      const [ws, ns] = await Promise.all([listWorkgroups(ctx, region), listNamespaces(ctx, region)]);
      if (!ws) return { key: r.key, sections: [{ title: "Workgroup", note: "Redshift Serverless couldn't be read just now." }] };
      return pick(ws, ns.items);
    }
    if (ctx.mock) return clusterDetail(r.key, simClusters(region).find((c) => c.ClusterIdentifier === r.name));
    let c: RawRedshiftCluster | undefined;
    try {
      c = (await listClusters(ctx, region, r.name))[0];
    } catch (e) {
      if (!/NotFound/.test((e as { name?: string })?.name ?? "")) throw e;
    }
    return clusterDetail(r.key, c);
  },
};
