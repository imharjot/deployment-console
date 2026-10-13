// RDS clusters and proxies provider: Aurora and Multi-AZ DB clusters, DocumentDB and Neptune clusters (the same RDS
// API), RDS proxies and global databases. Lists DescribeDBClusters and DescribeDBProxies (100 per page; RDS refuses
// fewer than 20), then the subnet groups (DBCluster.DBSubnetGroup is only a name, CC-14) and, when a cluster belongs to
// one, the global databases; hands that to ctx.checkpoint, then reads each proxy's targets through enrich() (R18,
// first 300). Cluster tags come with the listing; proxy tags aren't read (tagsUnread, R01). Activity: connections per
// Aurora / DocumentDB cluster and client connections per proxy (required, R20); Neptune and Multi-AZ DB clusters have
// none. Clusters are never linked to their instances — the rds provider gives instances their parent. Read-only: no
// actions. The mapping is pure (../../inventory/rds-cluster.ts).
import "server-only";
import {
  DescribeDBClustersCommand, DescribeDBProxiesCommand, DescribeDBProxyTargetsCommand, DescribeDBSubnetGroupsCommand, DescribeGlobalClustersCommand, RDSClient,
} from "@aws-sdk/client-rds";
import { parseArn } from "../../inventory/arn.ts";
import { propOf } from "../../inventory/compute-common.ts";
import {
  clusterDetail, proxyDetail, rdsClusterResult, type RawDbCluster, type RawGlobalCluster, type RawProxy, type RawProxyTarget, type RawSubnetGroup, type RdsClusterInput,
} from "../../inventory/rds-cluster.ts";
import type { EnrichState } from "../../inventory/types.ts";
import { errText } from "../errors.ts";
import { simClusters, simGlobalClusters, simLastConnection, simProxies, simSubnetGroups } from "./mock/rds-cluster.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import { deniedAction, type ActivitySpec, type Provider, type ProviderContext } from "./types.ts";

const rds = perRegion((region) => new RDSClient(sdkConfig(region)), "rds");
const PAGE = 100; // RDS: 20–100
const TARGETS_MAX = 300;

const listClusters = (ctx: ProviderContext, region: string) =>
  paged(ctx, "rds clusters", async (Marker) => {
    const r = await rds(region).send(new DescribeDBClustersCommand({ MaxRecords: PAGE, Marker }), t(ctx));
    return { items: r.DBClusters as RawDbCluster[] | undefined, next: r.Marker };
  }, { service: "rds" });

const listProxies = (ctx: ProviderContext, region: string) =>
  paged(ctx, "rds proxies", async (Marker) => {
    const r = await rds(region).send(new DescribeDBProxiesCommand({ MaxRecords: PAGE, Marker }), t(ctx));
    return { items: r.DBProxies as RawProxy[] | undefined, next: r.Marker };
  }, { service: "rds" });

async function proxyTargets(ctx: ProviderContext, region: string, name: string): Promise<RawProxyTarget[]> {
  const out: RawProxyTarget[] = [];
  let Marker: string | undefined;
  do {
    const r = await rds(region).send(new DescribeDBProxyTargetsCommand({ DBProxyName: name, MaxRecords: PAGE, Marker }), t(ctx));
    out.push(...((r.Targets ?? []) as RawProxyTarget[]));
    Marker = r.Marker || undefined;
  } while (Marker && !ctx.signal.aborted);
  return out;
}

// The subnet groups, read once per region; the state says why vpcId / subnets are missing when they are.
async function subnetGroups(ctx: ProviderContext, region: string, filter?: string): Promise<{ groups?: RawSubnetGroup[]; state: EnrichState }> {
  try {
    const groups = await paged(ctx, "rds subnet groups", async (Marker) => {
      const r = await rds(region).send(new DescribeDBSubnetGroupsCommand({ ...(filter ? { DBSubnetGroupName: filter } : {}), MaxRecords: PAGE, Marker }), t(ctx));
      return { items: r.DBSubnetGroups as RawSubnetGroup[] | undefined, next: r.Marker };
    }, { service: "rds" });
    return { groups, state: "ok" };
  } catch (e) {
    if (ctx.signal.aborted) return { state: "skipped" };
    const action = deniedAction(e);
    ctx.note(action ? `rds subnet groups skipped: ${action} denied` : `rds subnet groups: ${errText(e)}`);
    return { state: action ? "denied" : "error" };
  }
}

const globalClusters = (ctx: ProviderContext, region: string, id?: string) =>
  softly(ctx, "rds global databases", { limited: false, service: "rds" })(() =>
    paged(ctx, "rds global databases", async (Marker) => {
      const r = await rds(region).send(new DescribeGlobalClustersCommand({ ...(id ? { GlobalClusterIdentifier: id } : {}), MaxRecords: PAGE, Marker }), t(ctx));
      return { items: r.GlobalClusters as RawGlobalCluster[] | undefined, next: r.Marker };
    }, { service: "rds" }),
  );

const options = (ctx: ProviderContext) => ({ region: ctx.region, account: ctx.accountId, home: ctx.home, regions: ctx.regions, now: Date.now() });

function simInput(region: string): RdsClusterInput {
  return { clusters: simClusters(region), subnetGroups: simSubnetGroups(region), subnetGroupsState: "ok", proxies: simProxies(region), globals: simGlobalClusters(region) };
}

async function fetchInput(ctx: ProviderContext): Promise<RdsClusterInput> {
  const region = ctx.region;
  const [clusters, listed] = await Promise.all([listClusters(ctx, region), listProxies(ctx, region)]);
  const [sg, globals] = await Promise.all([
    clusters.some((c) => c.DBSubnetGroup) ? subnetGroups(ctx, region) : Promise.resolve({ groups: [], state: "ok" as EnrichState }),
    clusters.some((c) => c.GlobalClusterIdentifier) ? globalClusters(ctx, region) : Promise.resolve([]),
  ]);
  const proxies = listed.map((p): RawProxy => ({ ...p, enrichment: { targets: "skipped" } }));
  const input: RdsClusterInput = { clusters, subnetGroups: sg.groups, subnetGroupsState: sg.state, proxies, globals };
  ctx.checkpoint?.(rdsClusterResult(input, options(ctx)));
  const r = await enrich(ctx, proxies, { label: "rds proxy targets", max: TARGETS_MAX, until: budget() }, (p) => proxyTargets(ctx, region, p.DBProxyName!));
  return { ...input, proxies: proxies.map((p, i) => ({ ...p, ...(r.state[i] === "ok" ? { targets: r.results[i] ?? [] } : {}), enrichment: { targets: r.state[i] } })) };
}

const notFound = (e: unknown) => /NotFound/.test((e as { name?: string })?.name ?? "");

export const rdsClusterProvider: Provider = {
  id: "rds-cluster",
  label: "RDS clusters and proxies",
  kinds: ["rds-cluster", "docdb-cluster", "neptune-cluster", "rds-proxy"],
  scope: "regional",
  covers: ["rds:cluster", "rds:db-proxy", "rds:global-cluster", "rds:cluster-endpoint"],
  ttlMs: 2 * 60_000,
  multiRegionMock: true,
  read: ["rds:DescribeDBClusters", "rds:DescribeDBProxies", "rds:DescribeDBProxyTargets", "rds:DescribeGlobalClusters", "rds:DescribeDBSubnetGroups"],
  async discover(ctx) {
    if (ctx.mock) {
      const out = rdsClusterResult(simInput(ctx.region), options(ctx));
      for (const r of out.resources) r.lastActivityAt = simLastConnection();
      return out;
    }
    return rdsClusterResult(await fetchInput(ctx), options(ctx));
  },
  // A.2 #12, only with documented dimensions: Aurora (AWS/RDS) and DocumentDB (AWS/DocDB) aggregate connections per
  // cluster; proxies report client connections per ProxyName. Neptune and Multi-AZ DB clusters: none (never idle).
  activity: (r) => {
    const region = parseArn(r.key)?.region || undefined;
    const spec = (namespace: string, metric: string, dims: Record<string, string>, label: string): ActivitySpec[] => [{ namespace, metric, dims, stat: "Maximum", label, region, required: true }];
    if (r.kind === "rds-proxy") return spec("AWS/RDS", "ClientConnections", { ProxyName: r.name }, "peak client connections per day (idle check)");
    if (r.kind === "docdb-cluster") return spec("AWS/DocDB", "DatabaseConnections", { DBClusterIdentifier: r.name }, "peak connections per day (idle check)");
    if (r.kind === "rds-cluster" && /^aurora/.test(propOf(r, "Engine") ?? "")) return spec("AWS/RDS", "DatabaseConnections", { DBClusterIdentifier: r.name }, "peak connections per day (idle check)");
    return [];
  },
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (r.kind === "rds-proxy") {
      if (ctx.mock) return proxyDetail(r.key, simProxies(region).find((p) => p.DBProxyArn === r.key));
      let p: RawProxy | undefined;
      try {
        p = (await rds(region).send(new DescribeDBProxiesCommand({ DBProxyName: r.name }), t(ctx))).DBProxies?.[0] as RawProxy | undefined;
      } catch (e) {
        if (!notFound(e)) throw e;
      }
      if (!p) return proxyDetail(r.key, undefined);
      const targets = await softly(ctx, "rds proxy targets", { service: "rds" })(() => proxyTargets(ctx, region, r.name));
      return proxyDetail(r.key, { ...p, ...(targets ? { targets } : {}), enrichment: { targets: targets ? "ok" : "error" } });
    }
    if (ctx.mock) {
      const c = simClusters(region).find((x) => x.DBClusterArn === r.key);
      return clusterDetail(r.key, c, {
        subnetGroup: simSubnetGroups(region).find((g) => g.DBSubnetGroupName === c?.DBSubnetGroup),
        global: simGlobalClusters(region).find((g) => g.GlobalClusterIdentifier === c?.GlobalClusterIdentifier),
      });
    }
    let c: RawDbCluster | undefined;
    try {
      c = (await rds(region).send(new DescribeDBClustersCommand({ DBClusterIdentifier: r.key }), t(ctx))).DBClusters?.[0] as RawDbCluster | undefined;
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    if (!c) return clusterDetail(r.key, undefined);
    const [sg, globals] = await Promise.all([
      c.DBSubnetGroup ? subnetGroups(ctx, region, c.DBSubnetGroup) : undefined,
      c.GlobalClusterIdentifier ? globalClusters(ctx, region, c.GlobalClusterIdentifier) : undefined,
    ]);
    return clusterDetail(r.key, c, { subnetGroup: sg?.groups?.[0], global: globals?.[0] });
  },
};
