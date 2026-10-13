// EventBridge Scheduler provider: schedules with when they run and what they start. ListSchedules (100 per page, every
// group: no ListScheduleGroups), checkpoint, then GetSchedule per schedule through enrich() (R18, first 300) for the
// expression, window, retry policy, dead-letter queue, role and input. Input becomes mentions only. Schedules carry no
// tags and Resource Explorer doesn't index them (covers nothing). Read-only: no actions, no activity series. The
// mapper is pure (../../inventory/scheduling.ts).
import "server-only";
import { GetScheduleCommand, ListSchedulesCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { parseArn } from "../../inventory/arn.ts";
import { schedulerDetail, schedulerResult, type RawSchedule } from "../../inventory/scheduling.ts";
import { simSchedules } from "./mock/scheduler.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const scheduler = perRegion((region) => new SchedulerClient(sdkConfig(region)), "scheduler");
const DETAIL_MAX = 300;

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;
// Deleted since discovery: the panel says "no longer exists" instead of failing.
const orGone = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => (/NotFound/.test((e as { name?: string })?.name ?? "") ? undefined : Promise.reject(e)));

const getSchedule = async (region: string, group: string, name: string, ctx: ProviderContext): Promise<RawSchedule> => {
  const { $metadata, ...s } = await scheduler(region).send(new GetScheduleCommand({ GroupName: group, Name: name }), t(ctx));
  void $metadata;
  return s;
};

async function fetchSchedules(ctx: ProviderContext): Promise<RawSchedule[]> {
  const list = await paged(ctx, "schedules", async (NextToken) => {
    const r = await scheduler(ctx.region).send(new ListSchedulesCommand({ MaxResults: 100, NextToken }), t(ctx));
    return { items: r.Schedules, next: r.NextToken };
  }, { service: "scheduler" });
  const base = list.filter((s) => s.Arn && s.Name).map((s): RawSchedule => ({ ...s, enrichment: { schedule: "skipped" } }));
  const o = { region: ctx.region, account: ctx.accountId, now: Date.now() };
  ctx.checkpoint?.(schedulerResult(base, o));
  const r = await enrich(ctx, base, { label: "schedule details", max: DETAIL_MAX, until: budget() }, (s) => getSchedule(ctx.region, s.GroupName ?? "default", s.Name!, ctx));
  return base.map((s, i) => ({ ...s, ...(r.state[i] === "ok" ? (r.results[i] ?? {}) : {}), enrichment: { schedule: r.state[i] } }));
}

export const schedulerProvider: Provider = {
  id: "scheduler",
  label: "EventBridge Scheduler",
  kinds: ["schedule"],
  scope: "regional",
  covers: [],
  ttlMs: 5 * 60_000,
  multiRegionMock: true,
  read: ["scheduler:ListSchedules", "scheduler:GetSchedule"],
  async discover(ctx) {
    const now = Date.now();
    return schedulerResult(ctx.mock ? simSchedules(ctx.region, now) : await fetchSchedules(ctx), { region: ctx.region, account: ctx.accountId, now });
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    const now = Date.now();
    if (ctx.mock) return schedulerDetail(r.key, simSchedules(region, now).find((s) => s.Arn === r.key), now);
    // "…:schedule/<group>/<name>"
    const [group, ...rest] = (parseArn(r.key)?.id ?? "").split("/");
    return schedulerDetail(r.key, rest.length ? await orGone(getSchedule(region, group, rest.join("/"), ctx)) : undefined, now);
  },
};
