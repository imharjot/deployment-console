// EventBridge provider: event buses (the default one listed but not drawn) and every rule (schedule or event pattern)
// with its targets — Lambda, SQS, SNS, Step Functions, Kinesis, ECS tasks, other buses, API destinations (edge to the
// endpoint's host) — as edges bus → rule → target, plus target dead-letter queues and the roles the rule and its
// targets run as. A disabled rule shows as stopped. Discovery lists buses and rules, hands them to ctx.checkpoint,
// then reads targets and tags through enrich() (R18); a rule whose tags weren't read is tagsUnread (R01). Actions:
// enable / disable a rule.
import "server-only";
import {
  DisableRuleCommand, EnableRuleCommand, EventBridgeClient, ListApiDestinationsCommand, ListEventBusesCommand, ListRulesCommand, ListTagsForResourceCommand,
  ListTargetsByRuleCommand,
} from "@aws-sdk/client-eventbridge";
import { arnName, clip, describeSchedule, parseArn, propOf, tagMap, type EbTarget } from "../../inventory/serverless-common.ts";
import { EB_P, eventsResult, targetName, type RawBus, type RawEvents, type RawRule } from "../../inventory/serverless-messaging.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { simEvents, simRule, simRuleRate, simSetRuleState } from "./mock/eventbridge.ts";
import { series } from "./mock/serverless-sim.ts";
import { budget, conflict, enrich, invalid, paged, perRegion, sdkConfig, simDelay, softly, t } from "./serverless-util.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const events = perRegion((region) => new EventBridgeClient(sdkConfig(region)), "events");
const TAGS_MAX = 500;
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;
// "rule/name" (default bus) or "rule/bus/name".
const busOf = (r: Resource) => propOf(r, EB_P.bus) ?? (/:rule\/([^/]+)\/[^/]+$/.exec(r.key)?.[1] || "default");

async function targetsOf(c: EventBridgeClient, Rule: string, EventBusName: string, ctx: { signal?: AbortSignal }): Promise<EbTarget[]> {
  const out: EbTarget[] = [];
  let NextToken: string | undefined;
  do {
    const r = await c.send(new ListTargetsByRuleCommand({ Rule, EventBusName, NextToken, Limit: 100 }), t(ctx));
    out.push(...(r.Targets ?? []));
    NextToken = r.NextToken;
  } while (NextToken && out.length < 500);
  return out;
}

async function fetchEvents(ctx: ProviderContext): Promise<RawEvents> {
  const c = events(ctx.region);
  const buses: RawBus[] = await paged(ctx, "eventbridge buses", async (NextToken) => {
    const r = await c.send(new ListEventBusesCommand({ NextToken, Limit: 100 }), t(ctx));
    return { items: r.EventBuses, next: r.NextToken };
  }, { service: "events" });
  const until = budget();
  const listRules = softly(ctx, "eventbridge rules", { limited: false, service: "events" });
  const perBus = await Promise.all(buses.map((b) => listRules(() => paged(ctx, `eventbridge rules on ${b.Name}`, async (NextToken) => {
    const r = await c.send(new ListRulesCommand({ EventBusName: b.Name, NextToken, Limit: 100 }), t(ctx));
    return { items: r.Rules, next: r.NextToken };
  }, { service: "events" }))));
  const listed = perBus.flatMap((x) => x ?? []);
  if (listed.length > ctx.cap) ctx.note(`eventbridge: showing the first ${ctx.cap.toLocaleString("en-US")} rules`);
  const rules: RawRule[] = listed.slice(0, ctx.cap).map((r) => ({ ...r, targets: [], enrichment: { targets: "skipped", tags: "skipped" } }));
  ctx.checkpoint?.(eventsResult({ buses: buses.map((b) => ({ ...b, enrichment: { tags: "skipped" } })), rules, apiDestinations: {} }));
  // Targets first (the edges), then tags of every bus and rule (protection).
  const targets = await enrich(ctx, rules, { label: "eventbridge targets", max: ctx.cap, until }, (r) => targetsOf(c, r.Name!, r.EventBusName ?? "default", ctx));
  const all: (RawBus | RawRule)[] = [...buses, ...rules];
  const tags = await enrich(ctx, all, { label: "eventbridge tags", max: TAGS_MAX, until }, async (x) => tagMap((await c.send(new ListTagsForResourceCommand({ ResourceARN: x.Arn }), t(ctx))).Tags));
  rules.forEach((r, i) => {
    r.targets = targets.results[i] ?? [];
    r.enrichment = { targets: targets.state[i] };
  });
  all.forEach((x, i) => {
    x.tags = tags.state[i] === "ok" ? (tags.results[i] ?? {}) : undefined;
    x.enrichment = { ...(x.enrichment ?? {}), tags: tags.state[i] };
  });
  // API destination targets resolve to their endpoint's host.
  const apiDestinations: Record<string, string> = {};
  if (rules.some((r) => r.targets.some((x) => x.Arn?.includes(":api-destination/")))) {
    const list = await softly(ctx, "eventbridge API destinations", { limited: false })(() => paged(ctx, "eventbridge API destinations", async (NextToken) => {
      const r = await c.send(new ListApiDestinationsCommand({ NextToken, Limit: 100 }), t(ctx));
      return { items: r.ApiDestinations, next: r.NextToken };
    }));
    for (const d of list ?? []) if (d.ApiDestinationArn && d.InvocationEndpoint) apiDestinations[d.ApiDestinationArn] = d.InvocationEndpoint;
  }
  return { buses, rules, apiDestinations };
}

// ---------- detail ----------

function ruleDetail(r: Resource, rule: RawRule | undefined, rate?: number): ResourceDetail {
  if (!rule) return { key: r.key, sections: [{ title: "Not found", note: "This rule no longer exists." }] };
  const human = describeSchedule(rule.ScheduleExpression);
  const inputOf = (x: EbTarget) => (x.InputTransformer ? "input transformer" : x.Input ? "constant JSON" : x.InputPath ? `path ${x.InputPath}` : "whole event");
  let pattern: string | undefined;
  try {
    pattern = rule.EventPattern ? JSON.stringify(JSON.parse(rule.EventPattern), null, 2) : undefined;
  } catch {
    pattern = rule.EventPattern;
  }
  const now = Date.now();
  return {
    key: r.key,
    sections: [
      {
        title: "Rule",
        rows: [
          { label: "State", value: rule.State ?? "?" },
          { label: "Bus", value: rule.EventBusName ?? "default" },
          ...(rule.ScheduleExpression ? [{ label: "Schedule", value: `${rule.ScheduleExpression}${human ? ` — ${human}` : ""}`, mono: true }] : []),
          ...(rule.RoleArn ? [{ label: "Role", value: rule.RoleArn, mono: true }] : []),
          ...(rule.ManagedBy ? [{ label: "Managed by", value: rule.ManagedBy }] : []),
        ],
        note: pattern ? `Event pattern:\n${clip(pattern, 2000)}` : undefined,
      },
      {
        title: "Targets",
        table: rule.targets.length ? {
          columns: ["Id", "Target", "Input", "Dead-letter queue", "Retries"],
          rows: rule.targets.map((x) => [x.Id ?? "", targetName(x), inputOf(x), x.DeadLetterConfig?.Arn ? arnName(x.DeadLetterConfig.Arn) : "", x.RetryPolicy ? `${x.RetryPolicy.MaximumRetryAttempts ?? 185} tries · ${x.RetryPolicy.MaximumEventAgeInSeconds ?? 86_400} s` : "default"]),
        } : undefined,
        note: rule.targets.length ? undefined : "No targets — the rule matches but delivers nowhere.",
      },
    ],
    metrics: rate !== undefined ? [{ id: "invocations", label: "Invocations (hourly)", points: series(`${r.key}:inv`, now, 24, 3_600_000, rule.State === "DISABLED" ? 0 : rate) }] : undefined,
  };
}

function busDetail(r: Resource, rules: RawRule[]): ResourceDetail {
  return {
    key: r.key,
    sections: [{
      title: "Rules on this bus",
      table: rules.length ? { columns: ["Rule", "State", "Matches", "Targets"], rows: rules.map((x) => [x.Name ?? "", x.State ?? "", x.ScheduleExpression ?? (x.EventPattern ? clip(x.EventPattern, 80) : ""), x.targets.map(targetName).join(", ")]) } : undefined,
      note: rules.length ? undefined : "No rules — events sent to this bus go nowhere.",
    }],
  };
}

async function realRule(r: Resource, ctx: ProviderContext): Promise<RawRule | undefined> {
  const c = events(regionOf(r, ctx.region));
  const bus = busOf(r);
  const list = await c.send(new ListRulesCommand({ EventBusName: bus, NamePrefix: r.name, Limit: 100 }), t(ctx));
  const rule = list.Rules?.find((x) => x.Name === r.name);
  if (!rule) return undefined;
  return { ...rule, targets: (await softly(ctx, "eventbridge targets")(() => targetsOf(c, r.name, bus, ctx))) ?? [] };
}

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  if (r.kind === "eventbridge-bus") {
    if (ctx.mock) return busDetail(r, simEvents(regionOf(r, ctx.region)).rules.filter((x) => (x.EventBusName ?? "default") === r.name));
    const c = events(regionOf(r, ctx.region));
    const rules = (await softly(ctx, "eventbridge rules")(() => c.send(new ListRulesCommand({ EventBusName: r.name, Limit: 100 }), t(ctx))))?.Rules ?? [];
    return busDetail(r, rules.map((x) => ({ ...x, targets: [] })));
  }
  if (ctx.mock) return ruleDetail(r, simEvents(regionOf(r, ctx.region)).rules.find((x) => x.Arn === r.key), simRuleRate(r.key));
  return ruleDetail(r, await realRule(r, ctx));
}

// ---------- actions ----------

async function liveRule(r: Resource, ctx: ActionContext): Promise<RawRule> {
  const rule = ctx.mock
    ? simEvents(regionOf(r, ctx.region)).rules.find((x) => x.Arn === r.key)
    : await realRule(r, { region: ctx.region, mock: false, cap: 1, signal: AbortSignal.timeout(15_000), limit: (fn) => fn(), note: () => {} });
  if (!rule) throw invalid(`rule ${r.name} not found`);
  return rule;
}

function toggle(enable: boolean): ProviderAction<Record<string, never>> {
  const verb = enable ? "Enable" : "Disable";
  return {
    id: enable ? "enable-rule" : "disable-rule",
    kind: "eventbridge-rule",
    title: `${verb} rule`,
    description: enable
      ? "Enables the rule: its schedule fires again / matching events are delivered to its targets again. Refused when it's already enabled or managed by another AWS service."
      : "Disables the rule: its schedule stops firing and matching events are no longer delivered to its targets (events that arrive meanwhile are not queued). Refused when it's already disabled or managed by another AWS service.",
    risk: "change",
    perm: "act",
    summary: enable ? "Turns the rule back on: its schedule fires and matching events reach its targets again." : "Turns the rule off: its schedule stops and matching events stop reaching its targets.",
    iam: [enable ? "events:EnableRule" : "events:DisableRule"],
    undo: enable ? "Disable the rule again" : "Enable the rule again — events that arrived while it was off are not delivered later",
    verifies: `The rule's state reads ${enable ? "ENABLED" : "DISABLED"}`,
    retrySafe: true,
    input: { type: "object", additionalProperties: false, properties: {} },
    when: (r) => {
      if (propOf(r, EB_P.managedBy)) return `managed by ${propOf(r, EB_P.managedBy)} — change it there`;
      const state = propOf(r, EB_P.state);
      if (enable && state && state !== "DISABLED") return "already enabled";
      if (!enable && state === "DISABLED") return "already disabled";
      return undefined;
    },
    async plan(r, _i, ctx) {
      const rule = await liveRule(r, ctx);
      if (rule.ManagedBy) throw conflict(`managed by ${rule.ManagedBy} — change it there`);
      const human = describeSchedule(rule.ScheduleExpression);
      const what = rule.ScheduleExpression ? `schedule ${rule.ScheduleExpression}${human ? ` (${human})` : ""}` : "matching events";
      return {
        summary: `${verb} rule ${r.name} on bus ${rule.EventBusName ?? "default"}`,
        changes: [`${what} ${enable ? "will reach" : "will stop reaching"} ${rule.targets.length ? rule.targets.map(targetName).join(", ") : "its targets (none configured)"}`],
        warnings: [
          ...((enable ? rule.State !== "DISABLED" : rule.State === "DISABLED") ? [`the rule is already ${enable ? "enabled" : "disabled"}`] : []),
          ...(!enable && rule.EventPattern ? ["events that arrive while it's disabled are not delivered later"] : []),
        ],
      };
    },
    async run(r, _i, ctx) {
      const bus = busOf(r);
      if (ctx.mock) {
        await simDelay(300);
        return { rule: r.name, bus, ...simSetRuleState(r.name, bus, enable) };
      }
      const c = events(regionOf(r, ctx.region));
      await c.send(enable ? new EnableRuleCommand({ Name: r.name, EventBusName: bus }) : new DisableRuleCommand({ Name: r.name, EventBusName: bus }), t());
      return { rule: r.name, bus, state: enable ? "ENABLED" : "DISABLED" };
    },
  };
}

export const eventbridgeProvider: Provider = {
  id: "eventbridge",
  label: "EventBridge",
  scope: "regional",
  kinds: ["eventbridge-rule", "eventbridge-bus"],
  covers: ["events:event-bus", "events:rule"],
  multiRegionMock: true,
  read: ["events:ListEventBuses", "events:ListRules", "events:ListTargetsByRule", "events:ListTagsForResource", "events:ListApiDestinations"],
  write: ["events:EnableRule", "events:DisableRule"],
  async discover(ctx) {
    return eventsResult(ctx.mock ? simEvents(ctx.region) : await fetchEvents(ctx));
  },
  activity: (r) => {
    if (r.kind !== "eventbridge-rule") return [];
    const dims: Record<string, string> = busOf(r) === "default" ? { RuleName: r.name } : { EventBusName: busOf(r), RuleName: r.name };
    return [{ namespace: "AWS/Events", metric: "Invocations", dims, stat: "Sum", label: "Invocations", region: regionOf(r, r.region), required: true }];
  },
  detail,
  // R01: the rule's (or bus's) tags, read live right before a change (5 s; throws when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) {
      const rule = simRule(r.name, busOf(r));
      if (!rule || rule.Arn !== r.key) throw invalid(`rule ${r.name} not found`);
      return { tags: { ...(rule.tags ?? {}) } };
    }
    const out = await events(regionOf(r, ctx.region)).send(new ListTagsForResourceCommand({ ResourceARN: r.key }), t(undefined, AUTHORITATIVE_MS));
    return { tags: tagMap(out.Tags) };
  },
  actions: [toggle(true), toggle(false)] as ProviderAction[],
};
