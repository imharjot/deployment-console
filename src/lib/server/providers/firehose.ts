// Data Firehose provider: delivery streams with where they read from and deliver to, their processors, logging, keys
// and roles. ListDeliveryStreams (names only, paged with ExclusiveStartDeliveryStreamName), checkpoint, then
// DescribeDeliveryStream (first 300) and ListTagsForDeliveryStream (first 200) through enrich() (R18; unread tags:
// tagsUnread, R01). HTTP endpoint common attributes become mentions only; Splunk tokens and access keys are never
// copied (the mapper doesn't declare them). Activity: IncomingRecords. Read-only: no actions. The mapper is pure
// (../../inventory/streaming.ts).
import "server-only";
import { DescribeDeliveryStreamCommand, FirehoseClient, ListDeliveryStreamsCommand, ListTagsForDeliveryStreamCommand } from "@aws-sdk/client-firehose";
import { parseArn } from "../../inventory/arn.ts";
import { firehoseDetail, firehoseResult, type RawDeliveryStream } from "../../inventory/streaming.ts";
import { simFirehose } from "./mock/firehose.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const firehose = perRegion((region) => new FirehoseClient(sdkConfig(region)), "firehose");
const DESCRIBE_MAX = 300;
const TAGS_MAX = 200;

const regionOf = (key: string, fallback: string) => parseArn(key)?.region || fallback;
// Deleted since discovery: the panel says "no longer exists" instead of failing.
const orGone = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => (/NotFound/.test((e as { name?: string })?.name ?? "") ? undefined : Promise.reject(e)));

const describe = async (region: string, name: string, ctx: ProviderContext) =>
  (await firehose(region).send(new DescribeDeliveryStreamCommand({ DeliveryStreamName: name }), t(ctx))).DeliveryStreamDescription as RawDeliveryStream | undefined;
// A stream carries at most 50 tags: one page.
const tagsFor = async (region: string, name: string, ctx: ProviderContext) =>
  (await firehose(region).send(new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: name, Limit: 50 }), t(ctx))).Tags ?? [];

async function fetchStreams(ctx: ProviderContext): Promise<RawDeliveryStream[]> {
  const names = await paged(ctx, "firehose streams", async (start) => {
    const r = await firehose(ctx.region).send(new ListDeliveryStreamsCommand({ Limit: 10000, ExclusiveStartDeliveryStreamName: start }), t(ctx));
    const items = r.DeliveryStreamNames ?? [];
    return { items, next: r.HasMoreDeliveryStreams ? items[items.length - 1] : undefined };
  }, { service: "firehose" });
  const base = names.map((n): RawDeliveryStream => ({ DeliveryStreamName: n, enrichment: { describe: "skipped", tags: "skipped" } }));
  const o = { region: ctx.region, account: ctx.accountId };
  ctx.checkpoint?.(firehoseResult(base, o));
  const until = budget();
  const [details, tags] = await Promise.all([
    enrich(ctx, base, { label: "firehose stream details", max: DESCRIBE_MAX, until }, (s) => describe(ctx.region, s.DeliveryStreamName!, ctx)),
    enrich(ctx, base, { label: "firehose stream tags", max: TAGS_MAX, until }, (s) => tagsFor(ctx.region, s.DeliveryStreamName!, ctx)),
  ]);
  return base.map((s, i) => ({
    ...s,
    ...(details.state[i] === "ok" ? (details.results[i] ?? {}) : {}),
    DeliveryStreamName: s.DeliveryStreamName,
    tags: tags.state[i] === "ok" ? (tags.results[i] ?? []) : undefined,
    enrichment: { describe: details.state[i], tags: tags.state[i] },
  }));
}

export const firehoseProvider: Provider = {
  id: "firehose",
  label: "Data Firehose",
  kinds: ["firehose-stream"],
  scope: "regional",
  covers: ["firehose:deliverystream"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["firehose:ListDeliveryStreams", "firehose:DescribeDeliveryStream", "firehose:ListTagsForDeliveryStream"],
  async discover(ctx) {
    return firehoseResult(ctx.mock ? simFirehose(ctx.region) : await fetchStreams(ctx), { region: ctx.region, account: ctx.accountId });
  },
  activity: (r) => [{ namespace: "AWS/Firehose", metric: "IncomingRecords", dims: { DeliveryStreamName: r.name }, stat: "Sum", label: "Incoming records", region: regionOf(r.key, r.region), required: true }],
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return firehoseDetail(r.key, simFirehose(region).find((s) => s.DeliveryStreamARN === r.key));
    const [d, tags] = await Promise.all([
      orGone(describe(region, r.name, ctx)),
      softly(ctx, "firehose stream tags", { service: "firehose" })(() => tagsFor(region, r.name, ctx)),
    ]);
    return firehoseDetail(r.key, d ? { ...d, tags } : undefined);
  },
};
