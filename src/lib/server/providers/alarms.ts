// CloudWatch alarms provider (audit §6 A.2 #10, CC-11, CC-22): every metric and composite alarm in the region, with its
// state as health (ALARM error, long INSUFFICIENT_DATA on an alarm with actions or disabled actions a warning) and
// facts (alarmState, scaling), and what it watches as `monitors` links — through the pure dimension mapper in
// ../../inventory/alarms.ts. Scaling alarms (target tracking's AlarmHigh/AlarmLow, or alarms whose every action is a
// scaling policy) are ok and their links say "scales", so they never warn what they scale (propagate.ts R1). SNS
// actions become event links "on ALARM", Lambda actions invoke links.
//
// Two optional lookups make the mapping exact instead of guessed, both only when an alarm needs them: target group →
// ECS service from the environments' services in this region (discovery's shared, cached reads), and REST API name →
// id (API Gateway's GetRestApis; HTTP APIs are named by id already). Discovery lists (DescribeAlarms), hands the list to
// ctx.checkpoint, then reads tags per alarm through enrich() (R18). DescribeAlarmHistory runs only in detail().
// Read-only: no actions.
import "server-only";
import { APIGatewayClient, GetRestApisCommand } from "@aws-sdk/client-api-gateway";
import { CloudWatchClient, DescribeAlarmHistoryCommand, DescribeAlarmsCommand, ListTagsForResourceCommand } from "@aws-sdk/client-cloudwatch";
import { alarmResults, historyRows, type AlarmsInput, type RawCompositeAlarm, type RawHistoryItem, type RawMetricAlarm } from "../../inventory/alarms.ts";
import { parseArn } from "../../inventory/arn.ts";
import { keys, type EnrichState, type Resource, type ResourceDetail } from "../../inventory/types.ts";
import { listEnvs, servicesOf } from "../discovery.ts";
import { errText } from "../errors.ts";
import { homeRegion } from "../sources.ts";
import { simAlarmHistory, simAlarms } from "./mock/alarms.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const cw = perRegion((r) => new CloudWatchClient(sdkConfig(r)), "cloudwatch");
const apigw = perRegion((r) => new APIGatewayClient(sdkConfig(r)), "apigateway");
const TAGS_MAX = 200;
const HISTORY_MAX = 25;

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || fallback;
type AnyAlarm = (RawMetricAlarm & { kind: "metric" }) | (RawCompositeAlarm & { kind: "composite" });

// An optional join, waited for until `until` at most; never throws (a failure or a late answer is noted once).
async function bounded<T>(ctx: ProviderContext, label: string, until: number, p: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(250, until - Date.now()));
    ctx.signal.addEventListener("abort", () => resolve("late"), { once: true });
  });
  try {
    const r = await Promise.race([p.then((value) => ({ value }), (e: unknown) => ({ error: e })), late]);
    if (r === "late") {
      if (!ctx.signal.aborted) ctx.note(`${label}: not read in time`);
      return undefined;
    }
    if ("error" in r) {
      const denied = deniedAction(r.error);
      ctx.note(`${label}: ${denied ? `${denied} denied` : errText(r.error)}`);
      return undefined;
    }
    return r.value;
  } finally {
    clearTimeout(timer);
  }
}

const dimsNamed = (alarms: AnyAlarm[], name: string) =>
  alarms.some((a) => a.kind === "metric" && [a.Dimensions ?? [], ...(a.Metrics ?? []).map((q) => q.MetricStat?.Metric?.Dimensions ?? [])].some((d) => d.some((x) => x.Name === name)));

// Target group ARN → the ECS service it serves, for this region's environments (discovery's cached service reads).
async function targetGroups(region: string, home: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const envs = (await listEnvs()).filter((e) => e.region === region);
  await Promise.all(envs.map(async (e) => {
    for (const s of await servicesOf(e.cluster, e.region).catch(() => [])) for (const tg of s.targetGroupArns ?? []) out[tg] = keys.ecsService(e.cluster, s.name, e.region, home);
  }));
  return out;
}

// REST API name → ids in the region (GetRestApis pages of 500).
async function restApis(ctx: ProviderContext): Promise<Record<string, string[]>> {
  const c = apigw(ctx.region);
  const items = await paged(ctx, "alarms: REST API names", async (position) => {
    const r = await c.send(new GetRestApisCommand({ limit: 500, position }), t(ctx));
    return { items: r.items, next: r.position };
  }, { service: "apigateway" });
  const out: Record<string, string[]> = Object.create(null); // any name is a key ("constructor", "__proto__")
  for (const a of items) if (a.name && a.id) (out[a.name] ??= []).push(a.id);
  return out;
}

async function realInput(ctx: ProviderContext, base: Pick<AlarmsInput, "region" | "accountId" | "home" | "now">): Promise<AlarmsInput> {
  const c = cw(ctx.region);
  const alarms = await paged<AnyAlarm>(ctx, "cloudwatch alarms", async (NextToken) => {
    const r = await c.send(new DescribeAlarmsCommand({ AlarmTypes: ["MetricAlarm", "CompositeAlarm"], MaxRecords: 100, NextToken }), t(ctx));
    return {
      items: [...(r.MetricAlarms ?? []).map((a) => ({ ...a, kind: "metric" as const })), ...(r.CompositeAlarms ?? []).map((a) => ({ ...a, kind: "composite" as const }))],
      next: r.NextToken,
    };
  }, { service: "cloudwatch" });
  const metric = alarms.filter((a): a is RawMetricAlarm & { kind: "metric" } => a.kind === "metric");
  const composite = alarms.filter((a): a is RawCompositeAlarm & { kind: "composite" } => a.kind === "composite");
  // R18: the alarms as listed (tags not read yet, targets by dimension only); the lookups and tags come next.
  ctx.checkpoint?.(alarmResults({ ...base, metric, composite }));
  const until = budget();
  const arns = alarms.map((a) => a.AlarmArn).filter((x): x is string => !!x);
  const [tgs, apis, tags] = await Promise.all([
    dimsNamed(alarms, "TargetGroup") ? bounded(ctx, "alarms: target groups of ECS services", until, targetGroups(ctx.region, base.home ?? ctx.region)) : undefined,
    dimsNamed(alarms, "ApiName") ? softly(ctx, "alarms: REST API names", { limited: false, until, service: "apigateway" })(() => restApis(ctx)) : undefined,
    enrich(ctx, arns, { label: "cloudwatch alarm tags", max: TAGS_MAX, until }, async (ResourceARN) => {
      const r = await c.send(new ListTagsForResourceCommand({ ResourceARN }), t(ctx));
      return Object.fromEntries((r.Tags ?? []).filter((x) => x.Key).map((x) => [x.Key!, x.Value ?? ""]));
    }),
  ]);
  const tagMap: Record<string, Record<string, string> | undefined> = {};
  const tagState: Record<string, EnrichState> = {};
  arns.forEach((arn, i) => {
    tagState[arn] = tags.state[i];
    if (tags.state[i] === "ok") tagMap[arn] = tags.results[i] ?? {};
  });
  return { ...base, metric, composite, tags: tagMap, tagState, targetGroups: tgs, restApis: apis };
}

export const alarmsProvider: Provider = {
  id: "alarms",
  label: "CloudWatch alarms",
  kinds: ["cloudwatch-alarm"],
  scope: "regional",
  covers: ["cloudwatch:alarm"],
  ttlMs: 2 * 60_000,
  multiRegionMock: true,
  // apigateway:GET: REST API names → ids (GetRestApis), only when an alarm names an API by ApiName.
  read: ["cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:DescribeAlarmHistory", "apigateway:GET"],
  async discover(ctx) {
    const home = ctx.home ?? homeRegion();
    const base = { region: ctx.region, accountId: ctx.accountId, home, now: Date.now() };
    if (!ctx.mock) return alarmResults(await realInput(ctx, base));
    const sim = await simAlarms(ctx.region);
    const tgs = dimsNamed(sim.metric.map((a) => ({ ...a, kind: "metric" as const })), "TargetGroup") ? await bounded(ctx, "alarms: target groups of ECS services", budget(), targetGroups(ctx.region, home)) : undefined;
    return alarmResults({ ...base, metric: sim.metric, tags: sim.tags, targetGroups: tgs });
  },
  // The alarm's recent history: state changes, actions it ran, configuration updates (never the raw datapoints). AlarmTypes
  // names both kinds: without it DescribeAlarmHistory answers for metric alarms only, so a composite's history is empty.
  async detail(r, ctx): Promise<ResourceDetail> {
    let items: RawHistoryItem[] | undefined;
    let note: string | undefined;
    if (ctx.mock) items = simAlarmHistory(r.name);
    else {
      try {
        const out = await ctx.limit(() => cw(regionOf(r, ctx.region)).send(new DescribeAlarmHistoryCommand({ AlarmName: r.name, AlarmTypes: ["MetricAlarm", "CompositeAlarm"], MaxRecords: HISTORY_MAX, ScanBy: "TimestampDescending" }), t(ctx)), { service: "cloudwatch" });
        items = out.AlarmHistoryItems ?? [];
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        const denied = deniedAction(e);
        note = denied ? `The console's role can't read the alarm's history (${denied}).` : `History not loaded: ${errText(e)}`;
      }
    }
    const rows = items ? historyRows(items) : [];
    return {
      key: r.key,
      sections: [
        items
          ? { title: "History", table: { columns: ["When", "Type", "Summary"], rows }, ...(rows.length ? {} : { note: "No recent history." }) }
          : { title: "History", note },
      ],
    };
  },
};
