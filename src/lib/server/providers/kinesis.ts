// Kinesis provider: data streams with their capacity mode, open shards, retention, encryption (its KMS key: an encrypts
// edge) and enhanced fan-out consumers. Streams have no outgoing configuration; Lambda event source mappings
// (lambda.ts) and mentions link to them. Discovery lists (status and mode come with the list), hands the list to
// ctx.checkpoint, then reads summaries, consumers and tags through enrich() (R18); a stream whose tags weren't read is
// tagsUnread (R01); tags are read through every page (aws: tags don't count towards the 50 a stream may hold).
// authoritative() reads them live for a change made through another provider. Read-only: no actions.
import "server-only";
import { DescribeStreamSummaryCommand, KinesisClient, ListStreamConsumersCommand, ListStreamsCommand, ListTagsForStreamCommand } from "@aws-sdk/client-kinesis";
import { fmtTime, parseArn, tagMap } from "../../inventory/serverless-common.ts";
import { kinesisResult, type RawStream } from "../../inventory/serverless-data.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { simKinesis } from "./mock/kinesis.ts";
import { budget, enrich, invalid, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const kinesis = perRegion((region) => new KinesisClient(sdkConfig(region)), "kinesis");
const DETAILS_MAX = 500;
const TAG_PAGES = 10;
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;

const summaryOf = async (c: KinesisClient, StreamARN: string, ctx: { signal?: AbortSignal }) => (await c.send(new DescribeStreamSummaryCommand({ StreamARN }), t(ctx))).StreamDescriptionSummary ?? {};
const consumersOf = async (c: KinesisClient, StreamARN: string, ctx: { signal?: AbortSignal }) => (await c.send(new ListStreamConsumersCommand({ StreamARN, MaxResults: 100 }), t(ctx))).Consumers ?? [];

// Every page of a stream's tags. A last page that never comes throws: partial tags must never pass for all of them.
async function tagsOf(c: KinesisClient, StreamARN: string, opts: { abortSignal: AbortSignal }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let ExclusiveStartTagKey: string | undefined;
  for (let page = 0; ; page++) {
    const r = await c.send(new ListTagsForStreamCommand({ StreamARN, Limit: 50, ExclusiveStartTagKey }), opts);
    const tags = r.Tags ?? [];
    Object.assign(out, tagMap(tags));
    if (!r.HasMoreTags) return out;
    ExclusiveStartTagKey = tags.at(-1)?.Key;
    if (!ExclusiveStartTagKey || page + 1 >= TAG_PAGES) throw new Error(`kinesis tags of ${StreamARN.split("/").pop()}: incomplete (more pages than read)`);
  }
}

async function fetchKinesis(ctx: ProviderContext): Promise<RawStream[]> {
  const c = kinesis(ctx.region);
  const list = (await paged(ctx, "kinesis", async (NextToken) => {
    const r = await c.send(new ListStreamsCommand({ NextToken, Limit: 100 }), t(ctx));
    return { items: r.StreamSummaries, next: r.HasMoreStreams ? r.NextToken : undefined };
  }, { service: "kinesis" })).filter((s) => s.StreamARN);
  ctx.checkpoint?.(kinesisResult(list.map((s) => ({ ...s, enrichment: { summary: "skipped", consumers: "skipped", tags: "skipped" } }))));
  const until = budget();
  const read = <R>(label: string, fn: (arn: string) => Promise<R>) => enrich(ctx, list, { label: `kinesis ${label}`, max: DETAILS_MAX, until }, (s) => fn(s.StreamARN!));
  const [summaries, consumers, tags] = await Promise.all([
    read("stream details", (arn) => summaryOf(c, arn, ctx)),
    read("consumers", (arn) => consumersOf(c, arn, ctx)),
    read("tags", (arn) => tagsOf(c, arn, t(ctx))),
  ]);
  return list.map((s, i): RawStream => ({
    ...s, ...(summaries.results[i] ?? {}), StreamARN: s.StreamARN, consumers: consumers.results[i], tags: tags.state[i] === "ok" ? (tags.results[i] ?? {}) : undefined,
    enrichment: { summary: summaries.state[i], consumers: consumers.state[i], tags: tags.state[i] },
  }));
}

function buildDetail(r: Resource, s: RawStream | undefined): ResourceDetail {
  if (!s) return { key: r.key, sections: [{ title: "Not found", note: "This stream no longer exists." }] };
  const consumers = s.consumers ?? [];
  return {
    key: r.key,
    sections: [
      { title: "Stream", rows: r.props },
      {
        title: "Enhanced fan-out consumers",
        table: consumers.length ? { columns: ["Consumer", "Status"], rows: consumers.map((x) => [x.ConsumerName ?? "", x.ConsumerStatus ?? ""]) } : undefined,
        note: consumers.length ? undefined : "No registered consumers — readers poll shards directly (shared throughput). Lambda triggers show as edges on the map.",
      },
      ...(s.StreamCreationTimestamp ? [{ title: "History", rows: [{ label: "Created", value: fmtTime(s.StreamCreationTimestamp.getTime()) }] }] : []),
    ],
  };
}

async function realDetail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const c = kinesis(regionOf(r, ctx.region));
  const [summary, consumers] = await Promise.all([
    softly(ctx, "kinesis stream details")(() => summaryOf(c, r.key, ctx)),
    softly(ctx, "kinesis consumers")(() => consumersOf(c, r.key, ctx)),
  ]);
  return buildDetail(r, { StreamARN: r.key, ...(summary ?? {}), consumers });
}

export const kinesisProvider: Provider = {
  id: "kinesis",
  label: "Kinesis",
  scope: "regional",
  kinds: ["kinesis"],
  covers: ["kinesis:stream"],
  multiRegionMock: true,
  read: ["kinesis:ListStreams", "kinesis:DescribeStreamSummary", "kinesis:ListStreamConsumers", "kinesis:ListTagsForStream"],
  async discover(ctx) {
    return kinesisResult(ctx.mock ? simKinesis(ctx.region) : await fetchKinesis(ctx));
  },
  activity: (r) => [{ namespace: "AWS/Kinesis", metric: "IncomingRecords", dims: { StreamName: r.name }, stat: "Sum", label: "Incoming records", region: regionOf(r, r.region), required: true }],
  async detail(r, ctx) {
    if (ctx.mock) return buildDetail(r, simKinesis(regionOf(r, ctx.region)).find((s) => s.StreamARN === r.key));
    return realDetail(r, ctx);
  },
  // R01: the stream's tags, read live right before a change another provider makes to it (5 s for every page; throws
  // when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) {
      const stream = simKinesis(regionOf(r, ctx.region)).find((s) => s.StreamARN === r.key);
      if (!stream) throw invalid(`stream ${r.name} not found`);
      return { tags: { ...(stream.tags ?? {}) } };
    }
    return { tags: await tagsOf(kinesis(regionOf(r, ctx.region)), r.key, t(undefined, AUTHORITATIVE_MS)) };
  },
};
