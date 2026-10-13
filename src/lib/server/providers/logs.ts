// CloudWatch Logs provider (audit §6 A.2 #9): every log group in the region — retention, size, class, KMS key,
// subscription filters and tags — keyed by logGroupArn (no ":*"). Links: subscriptions → their destinations, AWS's
// naming conventions (/aws/lambda/<fn>, /aws/rds/…, /aws/codebuild/…, /aws/eks/…, API Gateway execution logs) as
// "mentioned" logs edges, and — in the home-region run only (CC-19) — every ECS service of every environment to the
// group its containers log to (discovery's shared service reads, never a second ECS pass). Container Insights and
// vended groups are hidden. A group that never expires and holds more than 10 GiB is a warning. The mapping is pure
// (../../inventory/logs.ts).
//
// Discovery lists (DescribeLogGroups, 50 a page, at most 2,000), hands the list to ctx.checkpoint, then reads
// subscription filters (first 300) and tags (first 200) per group through enrich() (R18). DescribeLogStreams runs only
// in detail(). Activity: AWS/Logs IncomingBytes per group (required: no bytes in means nothing writes there).
// Read-only: no actions.
import "server-only";
import { CloudWatchLogsClient, DescribeLogGroupsCommand, DescribeLogStreamsCommand, DescribeSubscriptionFiltersCommand, ListTagsForResourceCommand } from "@aws-sdk/client-cloudwatch-logs";
import { parseArn } from "../../inventory/arn.ts";
import { isHiddenGroup, logGroupResults, streamRows, subscriptionRows, type EcsLogUse, type LogsInput, type RawLogGroup, type RawLogStream, type RawSubscriptionFilter } from "../../inventory/logs.ts";
import { keys, type EnrichState, type Resource, type ResourceDetail } from "../../inventory/types.ts";
import { listEnvs, servicesOf } from "../discovery.ts";
import { errText } from "../errors.ts";
import { homeRegion } from "../sources.ts";
import { simLogGroups, simLogStreams } from "./mock/logs.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const logs = perRegion((r) => new CloudWatchLogsClient(sdkConfig(r)), "logs");
const SUBSCRIPTIONS_MAX = 300;
const TAGS_MAX = 200;
const STREAMS_SHOWN = 10;

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || fallback;

// Every ECS service's awslogs groups, across the console's environments (all regions: this runs once, in the home
// region). Discovery's service reads are cached and shared with the ECS views and providers.
async function ecsUses(home: string): Promise<EcsLogUse[]> {
  const out: EcsLogUse[] = [];
  await Promise.all((await listEnvs()).map(async (e) => {
    for (const s of await servicesOf(e.cluster, e.region).catch(() => [])) {
      const td = s.taskDef;
      if (!td) continue;
      const containers = td.containers?.length
        ? td.containers.map((c) => ({ name: c.name, logGroup: c.logGroup, ...(c.logRegion ? { logRegion: c.logRegion } : {}) }))
        : [{ name: td.main, logGroup: td.logGroup }];
      out.push({ service: keys.ecsService(e.cluster, s.name, e.region, home), label: `${e.cluster}/${s.name}`, region: e.region, taskDef: `${td.family}:${td.revision}`, containers });
    }
  }));
  return out;
}

// The ECS join, waited for until `until` at most; a failure or a late answer is noted once and leaves no links.
async function ecsJoin(ctx: ProviderContext, home: string, until: number): Promise<EcsLogUse[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(250, until - Date.now()));
    ctx.signal.addEventListener("abort", () => resolve("late"), { once: true });
  });
  try {
    const r = await Promise.race([ecsUses(home).then((value) => ({ value }), (e: unknown) => ({ error: e })), late]);
    if (r === "late") {
      if (!ctx.signal.aborted) ctx.note("logs: ECS services not read in time — no service → log group links this time");
      return undefined;
    }
    if ("error" in r) {
      ctx.note(`logs: ECS services not read (${deniedAction(r.error) ? `${deniedAction(r.error)} denied` : errText(r.error)})`);
      return undefined;
    }
    return r.value;
  } finally {
    clearTimeout(timer);
  }
}

// Visible groups first: the per-group reads are capped, and hidden groups are never drawn.
const visibleFirst = (groups: RawLogGroup[]) => [...groups].sort((a, b) => Number(isHiddenGroup(a.logGroupName ?? "")) - Number(isHiddenGroup(b.logGroupName ?? "")));

async function realInput(ctx: ProviderContext, base: Pick<LogsInput, "region" | "accountId" | "now">, home: string): Promise<LogsInput> {
  const c = logs(ctx.region);
  const groups = await paged<RawLogGroup>(ctx, "log groups", async (nextToken) => {
    const r = await c.send(new DescribeLogGroupsCommand({ limit: 50, nextToken }), t(ctx));
    return { items: r.logGroups, next: r.nextToken };
  }, { service: "logs" });
  ctx.checkpoint?.(logGroupResults({ ...base, groups }));
  const until = budget();
  const named = visibleFirst(groups).filter((g) => g.logGroupName);
  const [subs, tags, ecs] = await Promise.all([
    enrich(ctx, named, { label: "log group subscription filters", max: SUBSCRIPTIONS_MAX, until }, async (g) =>
      (await c.send(new DescribeSubscriptionFiltersCommand({ logGroupName: g.logGroupName, limit: 50 }), t(ctx))).subscriptionFilters ?? []),
    enrich(ctx, named, { label: "log group tags", max: TAGS_MAX, until }, async (g) =>
      (await c.send(new ListTagsForResourceCommand({ resourceArn: g.logGroupArn ?? g.arn?.replace(/:\*$/, "") }), t(ctx))).tags ?? {}),
    ctx.region === home ? ecsJoin(ctx, home, until) : undefined,
  ]);
  // By group name, which may be anything ("__proto__" included): objects without a prototype, so every name is a key.
  const subscriptions: Record<string, RawSubscriptionFilter[] | undefined> = Object.create(null);
  const subState: Record<string, EnrichState> = Object.create(null);
  const tagMap: Record<string, Record<string, string> | undefined> = Object.create(null);
  const tagState: Record<string, EnrichState> = Object.create(null);
  named.forEach((g, i) => {
    const n = g.logGroupName!;
    subState[n] = subs.state[i];
    if (subs.state[i] === "ok") subscriptions[n] = subs.results[i] ?? [];
    tagState[n] = tags.state[i];
    if (tags.state[i] === "ok") tagMap[n] = tags.results[i] ?? {};
  });
  return { ...base, groups, subscriptions, subState, tags: tagMap, tagState, ecs };
}

export const logsProvider: Provider = {
  id: "logs",
  label: "CloudWatch Logs",
  kinds: ["log-group"],
  scope: "regional",
  covers: ["logs:log-group"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["logs:DescribeLogGroups", "logs:DescribeSubscriptionFilters", "logs:ListTagsForResource", "logs:DescribeLogStreams"],
  async discover(ctx) {
    const home = ctx.home ?? homeRegion();
    const base = { region: ctx.region, accountId: ctx.accountId, now: Date.now() };
    if (!ctx.mock) return logGroupResults(await realInput(ctx, base, home));
    const sim = simLogGroups(ctx.region);
    const ecs = ctx.region === home ? await ecsJoin(ctx, home, budget()) : undefined;
    return logGroupResults({ ...base, groups: sim.groups, tags: sim.tags, subscriptions: sim.subscriptions, ecs });
  },
  activity: (r) => (r.hidden ? [] : [
    { namespace: "AWS/Logs", metric: "IncomingBytes", dims: { LogGroupName: r.name }, stat: "Sum", label: "Bytes written", region: regionOf(r, r.region), required: true },
  ]),
  // The newest log streams and the subscription filters as they are now.
  async detail(r, ctx): Promise<ResourceDetail> {
    const region = regionOf(r, ctx.region);
    let streams: RawLogStream[] | undefined;
    let subs: RawSubscriptionFilter[] | undefined;
    const notes: string[] = [];
    if (ctx.mock) {
      streams = await simLogStreams(region, r.name);
      subs = simLogGroups(region).subscriptions[r.name] ?? [];
    } else {
      const c = logs(region);
      const [a, b] = await Promise.allSettled([
        ctx.limit(() => c.send(new DescribeLogStreamsCommand({ logGroupName: r.name, orderBy: "LastEventTime", descending: true, limit: STREAMS_SHOWN }), t(ctx)), { service: "logs" }),
        ctx.limit(() => c.send(new DescribeSubscriptionFiltersCommand({ logGroupName: r.name, limit: 50 }), t(ctx)), { service: "logs" }),
      ]);
      const why = (e: unknown) => (deniedAction(e) ? `${deniedAction(e)} denied` : errText(e));
      if (a.status === "fulfilled") streams = a.value.logStreams ?? [];
      else notes.push(`log streams: ${why(a.reason)}`);
      if (b.status === "fulfilled") subs = b.value.subscriptionFilters ?? [];
      else notes.push(`subscription filters: ${why(b.reason)}`);
    }
    return {
      key: r.key,
      sections: [
        ...(streams ? [{ title: "Newest log streams", table: { columns: ["Stream", "Last event", "First event"], rows: streamRows(streams) }, ...(streams.length ? {} : { note: "No log streams: nothing has written here (or retention removed everything)." }) }] : []),
        ...(subs ? [{ title: "Subscription filters", table: { columns: ["Filter", "Destination", "Pattern"], rows: subscriptionRows(subs) }, ...(subs.length ? {} : { note: "No subscription filters: events stay in this log group." }) }] : []),
        ...(notes.length ? [{ title: "Not loaded", note: notes.join(" · ") }] : []),
      ],
    };
  },
};
