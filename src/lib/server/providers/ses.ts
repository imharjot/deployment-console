// SES provider: SES (v2) identities with their verification and the account's sending state. ListEmailIdentities (1,000
// per page) is the list call; then, only when the region has identities, GetAccount (sandbox, enforcement, sending),
// ListConfigurationSets and GetConfigurationSetEventDestinations (first 100 sets) — the checkpoint comes right after
// the list (R18). The sandbox is one account note, not a warning on every identity. GetEmailIdentity (DKIM, MAIL FROM,
// default configuration set, tags) is read only when a panel opens, so identities are tagsUnread in discovery (R01).
// Identities never become endpoints or aliases. Read-only: no actions, no activity series. The mapper is pure
// (../../inventory/ses.ts).
import "server-only";
import {
  GetAccountCommand, GetConfigurationSetEventDestinationsCommand, GetEmailIdentityCommand, ListConfigurationSetsCommand, ListEmailIdentitiesCommand, SESv2Client,
} from "@aws-sdk/client-sesv2";
import { parseArn } from "../../inventory/arn.ts";
import { SES_LINKED_MAX, sesAccountNote, sesDetail, sesResult, type RawIdentity, type SesAccount, type SesConfigurationSet, type SesEventDestination, type SesIdentityDetail } from "../../inventory/ses.ts";
import { simSes, simSesIdentityDetail } from "./mock/ses.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const ses = perRegion((region) => new SESv2Client(sdkConfig(region)), "ses");
const SETS_MAX = 100;

// Deleted since discovery: the panel says "no longer exists" instead of failing.
const orGone = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => (/NotFound/.test((e as { name?: string })?.name ?? "") ? undefined : Promise.reject(e)));

// GetAccount, the sending-state fields only (contact details and the use-case text stay out).
const getAccount = async (region: string, ctx: ProviderContext): Promise<SesAccount> => {
  const a = await ses(region).send(new GetAccountCommand({}), t(ctx));
  return { ProductionAccessEnabled: a.ProductionAccessEnabled, SendingEnabled: a.SendingEnabled, EnforcementStatus: a.EnforcementStatus, SendQuota: a.SendQuota };
};
const destinationsOf = async (region: string, name: string, ctx: ProviderContext) =>
  ((await ses(region).send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: name }), t(ctx))).EventDestinations ?? []) as SesEventDestination[];

async function configurationSets(ctx: ProviderContext, region: string, until: number): Promise<SesConfigurationSet[]> {
  const names = (await softly(ctx, "ses configuration sets", { limited: false, service: "ses" })(() => paged(ctx, "ses configuration sets", async (NextToken) => {
    const r = await ses(region).send(new ListConfigurationSetsCommand({ PageSize: 1000, NextToken }), t(ctx));
    return { items: r.ConfigurationSets, next: r.NextToken };
  }, { service: "ses" }))) ?? [];
  const r = await enrich(ctx, names, { label: "ses event destinations", max: SETS_MAX, until }, (n) => destinationsOf(region, n, ctx));
  return names.map((name, i) => ({ name, ...(r.state[i] === "ok" ? { destinations: r.results[i] ?? [] } : {}), state: r.state[i] }));
}

async function fetchSes(ctx: ProviderContext): Promise<Parameters<typeof sesResult>> {
  const region = ctx.region;
  const identities = await paged(ctx, "ses identities", async (NextToken) => {
    const r = await ses(region).send(new ListEmailIdentitiesCommand({ PageSize: 1000, NextToken }), t(ctx));
    return { items: r.EmailIdentities as RawIdentity[] | undefined, next: r.NextToken };
  }, { service: "ses" });
  const o = { region, account: ctx.accountId };
  if (!identities.length) return [[], o]; // an account that doesn't send from this region: nothing to say about it
  ctx.checkpoint?.(sesResult(identities, { ...o, accountState: "skipped" }));
  const until = budget();
  const [acct, sets] = await Promise.all([
    enrich(ctx, [region], { label: "ses account state", max: 1, until }, (r) => getAccount(r, ctx)),
    configurationSets(ctx, region, until),
  ]);
  const sesAccount = acct.state[0] === "ok" ? acct.results[0] : undefined;
  const note = sesAccountNote(sesAccount, region);
  if (note) ctx.note(note);
  if (identities.length > SES_LINKED_MAX && sets.some((s) => s.destinations?.length)) ctx.note(`ses: event destinations drawn for the first ${SES_LINKED_MAX} of ${identities.length.toLocaleString("en-US")} identities`);
  return [identities, { ...o, sesAccount, accountState: acct.state[0], configurationSets: sets }];
}

export const sesProvider: Provider = {
  id: "ses",
  label: "SES",
  kinds: ["ses-identity"],
  scope: "regional",
  covers: ["ses:identity"],
  ttlMs: 15 * 60_000,
  multiRegionMock: true,
  read: ["ses:ListEmailIdentities", "ses:GetAccount", "ses:ListConfigurationSets", "ses:GetConfigurationSetEventDestinations", "ses:GetEmailIdentity"],
  async discover(ctx) {
    if (!ctx.mock) return sesResult(...(await fetchSes(ctx)));
    const sim = simSes(ctx.region);
    const note = sim.identities.length ? sesAccountNote(sim.account, ctx.region) : undefined;
    if (note) ctx.note(note);
    return sesResult(sim.identities, { region: ctx.region, account: ctx.accountId, sesAccount: sim.account, accountState: "ok", configurationSets: sim.configurationSets });
  },
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    const name = parseArn(r.key)?.id ?? ""; // "…:identity/<domain or address>"
    if (ctx.mock) {
      const sim = simSes(region);
      const i = sim.identities.find((x) => x.IdentityName === name);
      return sesDetail(r.key, i && { ...i, detail: simSesIdentityDetail(name) }, { sesAccount: sim.account, configurationSets: sim.configurationSets });
    }
    const [d, sesAccount] = await Promise.all([
      orGone(ses(region).send(new GetEmailIdentityCommand({ EmailIdentity: name }), t(ctx))),
      softly(ctx, "ses account state", { service: "ses" })(() => getAccount(region, ctx)),
    ]);
    if (!d) return sesDetail(r.key, undefined);
    // Policy documents stay out: their names are enough for the panel.
    const detail: SesIdentityDetail = {
      DkimAttributes: d.DkimAttributes, MailFromAttributes: d.MailFromAttributes, ConfigurationSetName: d.ConfigurationSetName, VerifiedForSendingStatus: d.VerifiedForSendingStatus,
      FeedbackForwardingStatus: d.FeedbackForwardingStatus, Policies: Object.fromEntries(Object.keys(d.Policies ?? {}).map((k) => [k, ""])), Tags: d.Tags,
    };
    const set = d.ConfigurationSetName;
    const destinations = set ? await softly(ctx, "ses event destinations", { service: "ses" })(() => destinationsOf(region, set, ctx)) : undefined;
    return sesDetail(r.key, { IdentityName: name, IdentityType: d.IdentityType, VerificationStatus: d.VerificationStatus, detail }, {
      sesAccount, configurationSets: set && destinations ? [{ name: set, destinations, state: "ok" }] : [],
    });
  },
};
