// Simulated SES (v2) of the Acme account (names from ../mock-names.ts), per region: GetAccount (production access,
// healthy), ListEmailIdentities (the verified acme.example domain), its GetEmailIdentity detail (DKIM, MAIL FROM, the
// default configuration set) for the panel, and the acme-transactional configuration set, which sends bounces and
// complaints to the notifications topic. us-east-1 only; other regions have no identities. Read-only.
import type { RawIdentity, SesAccount, SesConfigurationSet } from "../../../inventory/ses.ts";
import { REGION, SES, SNS } from "../mock-names.ts";

export interface SimSes { account: SesAccount; identities: RawIdentity[]; configurationSets: SesConfigurationSet[] }

export function simSes(region: string): SimSes {
  const account: SesAccount = { ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 3_812 } };
  if (region !== REGION) return { account, identities: [], configurationSets: [] };
  return {
    account,
    identities: [{ IdentityType: "DOMAIN", IdentityName: SES.domain.identity, SendingEnabled: true, VerificationStatus: "SUCCESS" }],
    configurationSets: [{
      name: SES.configurationSet, state: "ok",
      destinations: [
        { Name: "bounces-and-complaints", Enabled: true, MatchingEventTypes: ["BOUNCE", "COMPLAINT"], SnsDestination: { TopicArn: SNS.notifications.arn } },
        { Name: "metrics", Enabled: true, MatchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT"], CloudWatchDestination: { DimensionConfigurations: [] } },
      ],
    }],
  };
}

// GetEmailIdentity, as the panel reads it.
export function simSesIdentityDetail(identity: string): RawIdentity["detail"] {
  if (identity !== SES.domain.identity) return undefined;
  return {
    DkimAttributes: { Status: "SUCCESS", SigningEnabled: true, SigningAttributesOrigin: "AWS_SES", CurrentSigningKeyLength: "RSA_2048_BIT" },
    MailFromAttributes: { MailFromDomain: `mail.${identity}`, MailFromDomainStatus: "SUCCESS", BehaviorOnMxFailure: "USE_DEFAULT_VALUE" },
    ConfigurationSetName: SES.configurationSet, VerifiedForSendingStatus: true, FeedbackForwardingStatus: false,
    Tags: [{ Key: "Environment", Value: "production" }],
  };
}
