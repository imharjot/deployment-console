// SES (v2) identities, pure part: ListEmailIdentities entries, the account's sending state (GetAccount) and the
// region's configuration-set event destinations, real or simulated, → Resources and identity → destination links
// (audit §6 A.2 #26, CC-19, master plan B7).
// - Key: arnOf.sesIdentity ("arn:…:ses:<r>:<a>:identity/<domain or address>"). Identities never go in endpoints or
//   aliases, and the name is "<identity> · domain|email" — a bare domain as the name would claim every mention of that
//   domain (and collide with the Route 53 zone of the same name).
// - Health: verified ok; PENDING or NOT_STARTED warning; FAILED or TEMPORARY_FAILURE error; DKIM FAILED warning (known
//   once GetEmailIdentity was read); sending disabled for the identity warning. Account state: PROBATION warns every
//   identity; SHUTDOWN, or sending paused for the account, is an error on every identity. The sandbox is NOT a warning:
//   it is a prop on each identity plus one account note (sesAccountNote) — a new account is in it by design.
// - Links: identity → the event destinations (SNS topic, Firehose stream, EventBridge bus, Pinpoint app) of the
//   configuration sets it may send with (event). Which set an identity uses is only known from GetEmailIdentity (detail
//   only), so discovery draws them as "allowed" (any send may name any set in the region), for the first 50 identities;
//   an identity whose default set is known links to that set's destinations only ("config").
// - Facts: state (the verification status). No activity series (SES metrics aren't per identity).
// No AWS calls and no `server-only`, so node:test runs it (ses.test.ts).
import { arnOf, parseArn } from "./arn.ts";
import { enrichmentOf, fmtCount, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

// GetAccount, the parts the map uses (contact details and the use-case description are never read).
export interface SesAccount {
  ProductionAccessEnabled?: boolean; // false = sandbox
  SendingEnabled?: boolean;
  EnforcementStatus?: string; // HEALTHY | PROBATION | SHUTDOWN
  SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number };
}

// GetEmailIdentity (the panel only): DKIM, MAIL FROM and the default configuration set.
export interface SesIdentityDetail {
  DkimAttributes?: { Status?: string; SigningEnabled?: boolean; SigningAttributesOrigin?: string; CurrentSigningKeyLength?: string };
  MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string; BehaviorOnMxFailure?: string };
  ConfigurationSetName?: string;
  VerifiedForSendingStatus?: boolean;
  FeedbackForwardingStatus?: boolean;
  Policies?: Record<string, string>; // names are shown, documents never
  Tags?: { Key?: string; Value?: string }[];
}

// ListEmailIdentities' IdentityInfo, plus GetEmailIdentity when it was read.
export interface RawIdentity {
  IdentityType?: string; // EMAIL_ADDRESS | DOMAIN | MANAGED_DOMAIN
  IdentityName?: string;
  SendingEnabled?: boolean;
  VerificationStatus?: string; // PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE | NOT_STARTED
  detail?: SesIdentityDetail;
}

export interface SesEventDestination {
  Name?: string;
  Enabled?: boolean;
  MatchingEventTypes?: string[];
  KinesisFirehoseDestination?: { DeliveryStreamArn?: string; IamRoleArn?: string };
  SnsDestination?: { TopicArn?: string };
  EventBridgeDestination?: { EventBusArn?: string };
  PinpointDestination?: { ApplicationArn?: string };
  CloudWatchDestination?: unknown;
}

// One configuration set with its event destinations (GetConfigurationSetEventDestinations), or why they weren't read.
export interface SesConfigurationSet {
  name: string;
  destinations?: SesEventDestination[];
  state?: EnrichState;
}

export const SES_LINKED_MAX = 50;

const TYPE: Record<string, string> = { EMAIL_ADDRESS: "email", DOMAIN: "domain", MANAGED_DOMAIN: "managed domain" };

// The note the provider adds once per region when the account is still in the sandbox.
export function sesAccountNote(a: SesAccount | undefined, region: string): string | undefined {
  if (!a || a.ProductionAccessEnabled !== false) return undefined;
  const quota = a.SendQuota?.Max24HourSend !== undefined ? `, ${fmtCount(a.SendQuota.Max24HourSend)} messages a day` : "";
  return `ses: the account is in the SES sandbox in ${region} — it can send only to verified addresses${quota}; request production access to send to anyone`;
}

function accountState(a: SesAccount | undefined): { health: Health; reason: string } | undefined {
  if (!a) return undefined;
  if (a.EnforcementStatus === "SHUTDOWN") return { health: "error", reason: "SES account shut down (sending stopped by AWS)" };
  if (a.SendingEnabled === false) return { health: "error", reason: "sending is paused for the SES account" };
  if (a.EnforcementStatus === "PROBATION") return { health: "warning", reason: "SES account on probation (bounce or complaint rate too high)" };
  return undefined;
}

const RANK: Record<Health, number> = { error: 4, warning: 3, stopped: 2, unknown: 1, ok: 0 };

function identityHealth(i: RawIdentity, a: SesAccount | undefined): { health: Health; reason?: string } {
  let h: { health: Health; reason?: string };
  switch (i.VerificationStatus) {
    case "SUCCESS":
      h = i.detail?.DkimAttributes?.Status === "FAILED" ? { health: "warning", reason: "DKIM verification failed" }
        : i.SendingEnabled === false ? { health: "warning", reason: "sending disabled for this identity" } : { health: "ok" };
      break;
    case "PENDING":
      h = { health: "warning", reason: "waiting for verification" };
      break;
    case "NOT_STARTED":
      h = { health: "warning", reason: "verification not started" };
      break;
    case "FAILED":
      h = { health: "error", reason: "verification failed" };
      break;
    case "TEMPORARY_FAILURE":
      h = { health: "error", reason: "verification temporarily failing (DNS records not found)" };
      break;
    default:
      h = { health: "unknown", reason: i.VerificationStatus ? `status ${i.VerificationStatus}` : "status not reported" };
  }
  const acct = accountState(a);
  return acct && RANK[acct.health] >= RANK[h.health] ? acct : h;
}

// The resource ids of one destination, with what it receives.
function destinationTargets(d: SesEventDestination): { to: string; what: string }[] {
  const out: { to: string; what: string }[] = [];
  if (d.SnsDestination?.TopicArn) out.push({ to: d.SnsDestination.TopicArn, what: "SNS" });
  if (d.KinesisFirehoseDestination?.DeliveryStreamArn) out.push({ to: d.KinesisFirehoseDestination.DeliveryStreamArn, what: "Firehose" });
  if (d.EventBridgeDestination?.EventBusArn) out.push({ to: d.EventBridgeDestination.EventBusArn, what: "EventBridge" });
  if (d.PinpointDestination?.ApplicationArn) out.push({ to: d.PinpointDestination.ApplicationArn, what: "Pinpoint" });
  return out;
}

const eventsLabel = (d: SesEventDestination) => {
  const ev = (d.MatchingEventTypes ?? []).map((e) => e.toLowerCase().replace(/_/g, " "));
  return ev.length ? (ev.length > 3 ? `${ev.slice(0, 3).join(", ")} +${ev.length - 3}` : ev.join(", ")) : "events";
};

export function sesConsoleUrl(region: string, identity: string) {
  return `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/identities/${encodeURIComponent(identity)}`;
}

export function sesResult(
  identities: RawIdentity[],
  o: { region: string; account?: string; sesAccount?: SesAccount; accountState?: EnrichState; configurationSets?: SesConfigurationSet[] },
): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const sets = o.configurationSets ?? [];
  const sandbox = o.sesAccount?.ProductionAccessEnabled === false;
  let linked = 0;
  for (const i of identities) {
    if (!i.IdentityName || !o.account) continue;
    const key = arnOf.sesIdentity(o.region, o.account, i.IdentityName);
    const type = TYPE[i.IdentityType ?? ""] ?? (i.IdentityName.includes("@") ? "email" : "domain");
    const { health, reason } = identityHealth(i, o.sesAccount);
    const facts: Facts = {};
    if (i.VerificationStatus) facts.state = i.VerificationStatus;
    const enrichment = enrichmentOf({ account: o.accountState });
    resources.push({
      key,
      kind: "ses-identity",
      provider: "ses",
      name: `${i.IdentityName} · ${type}`,
      region: o.region,
      ...tagsOf(i.detail?.Tags), // tags come with GetEmailIdentity only (the panel): tagsUnread in discovery
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Identity", value: i.IdentityName },
        { label: "Type", value: type },
        { label: "Verification", value: i.VerificationStatus?.toLowerCase().replace(/_/g, " ") },
        { label: "Sending", value: i.SendingEnabled === undefined ? undefined : i.SendingEnabled ? "enabled" : "disabled" },
        { label: "DKIM", value: i.detail?.DkimAttributes?.Status?.toLowerCase().replace(/_/g, " ") },
        {
          label: "Account",
          value: o.sesAccount
            ? `${sandbox ? "sandbox (verified recipients only)" : "production access"}${o.sesAccount.EnforcementStatus && o.sesAccount.EnforcementStatus !== "HEALTHY" ? ` · ${o.sesAccount.EnforcementStatus.toLowerCase()}` : ""}`
            : o.accountState && o.accountState !== "ok" ? unread("account state", o.accountState) : undefined,
        },
        { label: "Configuration set", value: i.detail?.ConfigurationSetName },
      ]),
      consoleUrl: sesConsoleUrl(o.region, i.IdentityName),
    });
    // Event destinations: the identity's own default set when known, else (first SES_LINKED_MAX identities) every set
    // in the region, as "allowed" — a send may name any of them.
    const own = i.detail?.ConfigurationSetName;
    const candidates = own ? sets.filter((s) => s.name === own) : linked < SES_LINKED_MAX ? sets : [];
    if (!own && candidates.length) linked++;
    for (const s of candidates)
      for (const d of s.destinations ?? []) {
        if (d.Enabled === false) continue;
        for (const t of destinationTargets(d))
          links.push({
            from: key, to: t.to, kind: "event", label: eventsLabel(d),
            evidence: own ? `SES default configuration set ${s.name}, destination ${d.Name ?? t.what}` : `SES configuration set ${s.name}, destination ${d.Name ?? t.what} (any send from this identity may use it)`,
            ...(own ? {} : { confidence: "allowed" as const }),
          });
      }
  }
  return { resources, links, mentions: [] };
}

export function sesDetail(key: string, i: RawIdentity | undefined, o: { sesAccount?: SesAccount; configurationSets?: SesConfigurationSet[] } = {}): ResourceDetail {
  if (!i) return { key, sections: [{ title: "Identity", note: "This identity no longer exists." }] };
  const d = i.detail;
  const a = o.sesAccount;
  const set = d?.ConfigurationSetName ? o.configurationSets?.find((s) => s.name === d.ConfigurationSetName) : undefined;
  const tags = (d?.Tags ?? []).filter((x) => x.Key);
  const region = parseArn(key)?.region ?? "";
  return {
    key,
    sections: [
      {
        title: "Identity",
        rows: props([
          { label: "Identity", value: i.IdentityName },
          { label: "Type", value: TYPE[i.IdentityType ?? ""] ?? i.IdentityType },
          { label: "Verification", value: i.VerificationStatus },
          { label: "Verified for sending", value: d?.VerifiedForSendingStatus === undefined ? undefined : d.VerifiedForSendingStatus ? "yes" : "no" },
          { label: "DKIM", value: d?.DkimAttributes ? `${d.DkimAttributes.Status ?? "?"}${d.DkimAttributes.SigningEnabled === false ? " (signing off)" : ""}${d.DkimAttributes.CurrentSigningKeyLength ? ` · ${d.DkimAttributes.CurrentSigningKeyLength}` : ""}` : undefined },
          { label: "MAIL FROM", value: d?.MailFromAttributes?.MailFromDomain ? `${d.MailFromAttributes.MailFromDomain} (${d.MailFromAttributes.MailFromDomainStatus ?? "?"})` : undefined },
          { label: "Feedback forwarding", value: d?.FeedbackForwardingStatus === undefined ? undefined : d.FeedbackForwardingStatus ? "on" : "off" },
          { label: "Configuration set", value: d?.ConfigurationSetName },
          { label: "Policies", value: d?.Policies && Object.keys(d.Policies).length ? Object.keys(d.Policies).join(", ") : undefined },
        ]),
      },
      ...(a
        ? [{
          title: `Account (${region})`,
          rows: props([
            { label: "Access", value: a.ProductionAccessEnabled === false ? "sandbox — verified recipients only" : "production" },
            { label: "Sending", value: a.SendingEnabled === undefined ? undefined : a.SendingEnabled ? "enabled" : "paused" },
            { label: "Enforcement", value: a.EnforcementStatus },
            { label: "Quota", value: a.SendQuota ? `${fmtCount(a.SendQuota.SentLast24Hours)} of ${fmtCount(a.SendQuota.Max24HourSend)} in 24 h · ${fmtCount(a.SendQuota.MaxSendRate)}/s` : undefined },
          ]),
        }]
        : []),
      ...(set?.destinations?.length
        ? [{ title: `Event destinations (${set.name})`, table: { columns: ["Destination", "Events", "Sends to"], rows: set.destinations.map((x) => [`${x.Name ?? "?"}${x.Enabled === false ? " (off)" : ""}`, eventsLabel(x), destinationTargets(x).map((t) => t.to).join(", ") || (x.CloudWatchDestination ? "CloudWatch metrics" : "—")]) } }]
        : []),
      ...(tags.length ? [{ title: "Tags", table: { columns: ["Key", "Value"], rows: tags.map((x) => [x.Key!, x.Value ?? ""]) } }] : []),
    ],
  };
}
