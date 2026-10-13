// Simulated EventBridge of the Acme account (names from ../mock-names.ts): the nightly schedule on the default bus
// that runs the report Lambda, the order-placed rule on the custom shop bus that feeds the orders queue and starts the
// checkout state machine (through a role EventBridge assumes), and a disabled hourly rule still pointing at the legacy
// cron. Only us-east-1 has them. Enable/disable change it.
import type { RawEvents, RawRule } from "../../../inventory/serverless-messaging.ts";
import { ACCT, EVENTS, LAMBDA, REGION, SFN, SQS } from "../mock-names.ts";
import { LEGACY_RULE } from "./lambda.ts";
import { DAY, HOUR, simState } from "./serverless-sim.ts";

// Per rule / bus: last activity (ms before now) and invocations per hour (charts), kept apart from the SDK shapes.
interface SimMeta {
  activeAgo: number;
  rate: number;
}

function build() {
  const now = Date.now();
  const meta: Record<string, SimMeta> = {};
  const rule = (r: RawRule, m: SimMeta): RawRule => {
    meta[r.Arn!] = m;
    return r;
  };
  const rules: RawRule[] = [
    rule({
      Name: EVENTS.nightlyRule.name, Arn: EVENTS.nightlyRule.arn, EventBusName: "default", State: "ENABLED", ScheduleExpression: EVENTS.nightlyRule.schedule,
      Description: "Builds the nightly sales report", tags: { Environment: "production", Team: "shop" },
      targets: [{ Id: "report", Arn: LAMBDA.nightlyReport.arn, RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 } }],
    }, { activeAgo: (((now % DAY) - 2 * HOUR) % DAY + DAY) % DAY, rate: 1 / 24 }),
    rule({
      Name: EVENTS.orderPlacedRule.name, Arn: EVENTS.orderPlacedRule.arn, EventBusName: EVENTS.shopBus.name, State: "ENABLED",
      EventPattern: JSON.stringify({ source: ["acme.shop"], "detail-type": ["OrderPlaced"], detail: { total: [{ numeric: [">", 0] }] } }),
      Description: "Every placed order: queue it and start checkout", tags: { Environment: "production", Team: "shop" },
      targets: [
        { Id: "orders-queue", Arn: SQS.orders.arn, InputPath: "$.detail" },
        { Id: "checkout", Arn: SFN.checkout.arn, RoleArn: `arn:aws:iam::${ACCT}:role/acme-events-start-checkout`, DeadLetterConfig: { Arn: SQS.ordersDlq.arn } },
      ],
    }, { activeAgo: 45_000, rate: 850 }),
    rule({
      Name: LEGACY_RULE, Arn: `arn:aws:events:${REGION}:${ACCT}:rule/${LEGACY_RULE}`, EventBusName: "default", State: "DISABLED", ScheduleExpression: "rate(1 hour)",
      Description: "Old backup cleanup (disabled after the move to S3 lifecycle rules)",
      targets: [{ Id: "cleanup", Arn: LAMBDA.legacyCleanup.arn, Input: JSON.stringify({ olderThanDays: 30 }) }],
    }, { activeAgo: 90 * DAY, rate: 0 }),
  ];
  return {
    buses: [
      { Name: "default", Arn: EVENTS.defaultBus.arn },
      { Name: EVENTS.shopBus.name, Arn: EVENTS.shopBus.arn, Description: "Domain events from the storefront", CreationTime: new Date(now - 300 * DAY), tags: { Environment: "production", Team: "shop" } },
    ],
    rules,
    meta: { ...meta, [EVENTS.shopBus.arn]: { activeAgo: 45_000, rate: 850 } } as Record<string, SimMeta>,
  };
}

const state = () => simState("__dcSimEvents", build);

export const simRule = (name: string, bus = "default"): RawRule | undefined => state().rules.find((r) => r.Name === name && (r.EventBusName ?? "default") === bus);
export const simRuleRate = (arn: string) => state().meta[arn]?.rate ?? 0;

export function simEvents(region: string = REGION): RawEvents {
  if (region !== REGION) return { buses: [], rules: [], apiDestinations: {} };
  const now = Date.now();
  const s = state();
  const last = (arn?: string) => (arn && s.meta[arn] ? now - s.meta[arn].activeAgo : undefined);
  return {
    buses: s.buses.map((b) => ({ ...b, tags: { ...(b.tags ?? {}) }, lastActivityAt: last(b.Arn) })),
    rules: s.rules.map((r) => ({ ...r, tags: { ...(r.tags ?? {}) }, targets: r.targets.map((t) => ({ ...t })), lastActivityAt: last(r.Arn) })),
    apiDestinations: {},
  };
}

export function simSetRuleState(name: string, bus: string, enabled: boolean) {
  const r = simRule(name, bus);
  if (!r) throw Object.assign(new Error(`Rule ${name} does not exist on EventBus ${bus}.`), { name: "ResourceNotFoundException" });
  const before = r.State;
  r.State = enabled ? "ENABLED" : "DISABLED";
  return { before, after: r.State };
}
