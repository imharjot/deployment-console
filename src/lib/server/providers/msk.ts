// MSK provider: provisioned and serverless Kafka clusters with every broker host they answer on (so KAFKA_BROKERS-style
// variables resolve), their network, encryption and broker logs. ListClustersV2 (100 per page; tags come with it),
// checkpoint, then GetBootstrapBrokers per cluster through enrich() (R18, first 300; skipped while a cluster is being
// created, failed or deleted — the API has no brokers to report then). Read-only: no actions, no activity series.
// The mapper is pure (../../inventory/msk.ts).
import "server-only";
import { GetBootstrapBrokersCommand, KafkaClient, ListClustersV2Command } from "@aws-sdk/client-kafka";
import { parseArn } from "../../inventory/arn.ts";
import { BOOTSTRAP_FIELDS, mskDetail, mskResult, type BootstrapBrokers, type RawMskCluster } from "../../inventory/msk.ts";
import { simMsk } from "./mock/msk.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const kafka = perRegion((region) => new KafkaClient(sdkConfig(region)), "kafka");
const BOOTSTRAP_MAX = 300;
const NO_BROKERS = new Set(["CREATING", "FAILED", "DELETING"]);

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;

// The bootstrap strings only (the response's other fields are request metadata).
const bootstrapOf = async (arn: string, ctx: ProviderContext): Promise<BootstrapBrokers> => {
  const r = (await kafka(regionOf(arn, ctx.region)).send(new GetBootstrapBrokersCommand({ ClusterArn: arn }), t(ctx))) as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.keys(BOOTSTRAP_FIELDS).flatMap((k) => (typeof r[k] === "string" ? [[k, r[k] as string]] : [])));
};

async function list(ctx: ProviderContext, region: string, nameFilter?: string): Promise<RawMskCluster[]> {
  const c = kafka(region);
  const clusters = await paged(ctx, "msk clusters", async (NextToken) => {
    const r = await c.send(new ListClustersV2Command({ MaxResults: 100, NextToken, ...(nameFilter ? { ClusterNameFilter: nameFilter } : {}) }), t(ctx));
    return { items: r.ClusterInfoList, next: r.NextToken };
  }, { service: "kafka" });
  // ListClustersV2 returns the tags with each cluster: no Tags field means none (not "not read").
  return clusters.filter((x) => x.ClusterArn).map((x) => ({ ...(x as RawMskCluster), Tags: x.Tags ?? {} }));
}

async function fetchClusters(ctx: ProviderContext): Promise<RawMskCluster[]> {
  const base = await list(ctx, ctx.region);
  const wanted = base.filter((x) => !NO_BROKERS.has(x.State ?? ""));
  ctx.checkpoint?.(mskResult(base.map((x) => ({ ...x, enrichment: wanted.includes(x) ? { bootstrap: "skipped" } : undefined }))));
  const r = await enrich(ctx, wanted, { label: "msk bootstrap brokers", max: BOOTSTRAP_MAX, until: budget() }, (x) => bootstrapOf(x.ClusterArn!, ctx));
  const read = new Map(wanted.map((x, i) => [x.ClusterArn, { value: r.results[i], state: r.state[i] }]));
  return base.map((x) => {
    const b = read.get(x.ClusterArn);
    return b ? { ...x, ...(b.state === "ok" ? { bootstrap: b.value ?? {} } : {}), enrichment: { bootstrap: b.state } } : x;
  });
}

export const mskProvider: Provider = {
  id: "msk",
  label: "MSK",
  kinds: ["msk-cluster"],
  scope: "regional",
  covers: ["kafka:cluster"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["kafka:ListClustersV2", "kafka:GetBootstrapBrokers"],
  async discover(ctx) {
    return mskResult(ctx.mock ? simMsk(ctx.region) : await fetchClusters(ctx));
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return mskDetail(r.key, simMsk(region).find((c) => c.ClusterArn === r.key));
    const c = (await list(ctx, region, r.name)).find((x) => x.ClusterArn === r.key);
    if (!c) return mskDetail(r.key, undefined);
    const bootstrap = NO_BROKERS.has(c.State ?? "") ? undefined : await softly(ctx, "msk bootstrap brokers", { service: "kafka" })(() => bootstrapOf(r.key, ctx));
    return mskDetail(r.key, { ...c, ...(bootstrap ? { bootstrap } : {}) });
  },
};
