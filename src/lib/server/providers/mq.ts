// Amazon MQ provider: ActiveMQ and RabbitMQ brokers with the hosts they answer on (hostnames only, never credentials),
// their network, encryption and logs. ListBrokers (100 per page), checkpoint, then DescribeBroker per broker through
// enrich() (R18, first 300; tags come with it — a broker it didn't answer for is tagsUnread, R01). Read-only: no
// actions, no activity series. The mapper is pure (../../inventory/streaming.ts).
import "server-only";
import { DescribeBrokerCommand, ListBrokersCommand, MqClient } from "@aws-sdk/client-mq";
import { parseArn } from "../../inventory/arn.ts";
import { mqDetail, mqResult, type RawBroker } from "../../inventory/streaming.ts";
import { simMq } from "./mock/mq.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const mq = perRegion((region) => new MqClient(sdkConfig(region)), "mq");
const DESCRIBE_MAX = 300;

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;
// Deleted since discovery: the panel says "no longer exists" instead of failing.
const orGone = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => (/NotFound/.test((e as { name?: string })?.name ?? "") ? undefined : Promise.reject(e)));

// DescribeBroker, the fields the mapper reads (user names stay out: only their count is kept).
async function describe(region: string, id: string, ctx: ProviderContext): Promise<Partial<RawBroker>> {
  const d = await mq(region).send(new DescribeBrokerCommand({ BrokerId: id }), t(ctx));
  return {
    BrokerArn: d.BrokerArn, BrokerId: d.BrokerId, BrokerName: d.BrokerName, BrokerState: d.BrokerState, Created: d.Created, DeploymentMode: d.DeploymentMode, EngineType: d.EngineType,
    HostInstanceType: d.HostInstanceType, EngineVersion: d.EngineVersion, BrokerInstances: d.BrokerInstances, PubliclyAccessible: d.PubliclyAccessible, SecurityGroups: d.SecurityGroups,
    SubnetIds: d.SubnetIds, EncryptionOptions: d.EncryptionOptions, Logs: d.Logs, ActionsRequired: d.ActionsRequired, AuthenticationStrategy: d.AuthenticationStrategy,
    StorageType: d.StorageType, Users: (d.Users ?? []).map(() => ({})), Tags: d.Tags ?? {}, described: true,
  };
}

async function fetchBrokers(ctx: ProviderContext): Promise<RawBroker[]> {
  const list = await paged(ctx, "mq brokers", async (NextToken) => {
    const r = await mq(ctx.region).send(new ListBrokersCommand({ MaxResults: 100, NextToken }), t(ctx));
    return { items: r.BrokerSummaries, next: r.NextToken };
  }, { service: "mq" });
  const base = list.filter((b) => b.BrokerArn && b.BrokerId).map((b): RawBroker => ({ ...b, enrichment: { describe: "skipped" } }));
  ctx.checkpoint?.(mqResult(base));
  const r = await enrich(ctx, base, { label: "mq broker details", max: DESCRIBE_MAX, until: budget() }, (b) => describe(ctx.region, b.BrokerId!, ctx));
  return base.map((b, i) => ({ ...b, ...(r.state[i] === "ok" ? (r.results[i] ?? {}) : {}), enrichment: { describe: r.state[i] } }));
}

export const mqProvider: Provider = {
  id: "mq",
  label: "Amazon MQ",
  kinds: ["mq-broker"],
  scope: "regional",
  covers: ["mq:broker"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["mq:ListBrokers", "mq:DescribeBroker"],
  async discover(ctx) {
    return mqResult(ctx.mock ? simMq(ctx.region) : await fetchBrokers(ctx));
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return mqDetail(r.key, simMq(region).find((b) => b.BrokerArn === r.key));
    const id = r.aliases?.[0] ?? parseArn(r.key)?.id.split(":")[1];
    return mqDetail(r.key, id ? await orGone(describe(region, id, ctx)) : undefined);
  },
};
