// EventBridge Pipes provider: pipes with their source, enrichment and target. ListPipes (100 per page; source, target,
// enrichment and state come with it), checkpoint, then DescribePipe per pipe through enrich() (R18, first 200) for the
// role, parameters, logging, KMS key and tags (unread: tagsUnread, R01). Input templates and HTTP parameters become
// mentions only. Read-only: no actions, no activity series. The mapper is pure (../../inventory/scheduling.ts).
import "server-only";
import { DescribePipeCommand, ListPipesCommand, PipesClient } from "@aws-sdk/client-pipes";
import { parseArn } from "../../inventory/arn.ts";
import { pipesDetail, pipesResult, type RawPipe } from "../../inventory/scheduling.ts";
import { simPipes } from "./mock/pipes.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const pipes = perRegion((region) => new PipesClient(sdkConfig(region)), "pipes");
const DESCRIBE_MAX = 200;

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;
// Deleted since discovery: the panel says "no longer exists" instead of failing.
const orGone = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => (/NotFound/.test((e as { name?: string })?.name ?? "") ? undefined : Promise.reject(e)));

const describe = async (region: string, name: string, ctx: ProviderContext): Promise<RawPipe> => {
  const { $metadata, ...p } = await pipes(region).send(new DescribePipeCommand({ Name: name }), t(ctx));
  void $metadata;
  return { ...(p as RawPipe), Tags: p.Tags ?? {}, described: true };
};

async function fetchPipes(ctx: ProviderContext): Promise<RawPipe[]> {
  const list = await paged(ctx, "pipes", async (NextToken) => {
    const r = await pipes(ctx.region).send(new ListPipesCommand({ Limit: 100, NextToken }), t(ctx));
    return { items: r.Pipes, next: r.NextToken };
  }, { service: "pipes" });
  const base = list.filter((p) => p.Arn && p.Name).map((p): RawPipe => ({ ...p, enrichment: { describe: "skipped" } }));
  ctx.checkpoint?.(pipesResult(base));
  const r = await enrich(ctx, base, { label: "pipe details", max: DESCRIBE_MAX, until: budget() }, (p) => describe(ctx.region, p.Name!, ctx));
  return base.map((p, i) => ({ ...p, ...(r.state[i] === "ok" ? (r.results[i] ?? {}) : {}), enrichment: { describe: r.state[i] } }));
}

export const pipesProvider: Provider = {
  id: "pipes",
  label: "EventBridge Pipes",
  kinds: ["pipe"],
  scope: "regional",
  covers: ["pipes:pipe"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["pipes:ListPipes", "pipes:DescribePipe"],
  async discover(ctx) {
    return pipesResult(ctx.mock ? simPipes(ctx.region) : await fetchPipes(ctx));
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return pipesDetail(r.key, simPipes(region).find((p) => p.Arn === r.key));
    return pipesDetail(r.key, await orGone(describe(region, r.name, ctx)));
  },
};
