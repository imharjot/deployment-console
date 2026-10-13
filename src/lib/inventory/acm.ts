// ACM certificates, pure part: ListCertificates summaries (+ DescribeCertificate for in-use or problem certificates,
// + tags), real or simulated, → Resources and certificate → user links (audit §6 A.2 #6).
// - Key: the certificate ARN. Domains never go in endpoints or aliases, and never alone in the name: a bare hostname
//   is indexed as a name and would capture every mention of the site. The name is "<domain> · <id prefix>", which no
//   reference can match; the domain itself is a prop.
// - Links: certificate → each InUseBy ARN (tls).
// - Health: ISSUED with more than 30 days left ok; 7 days or less error; 30 days or less without automatic renewal
//   (imported, renewal ineligible, renewal failed or still pending) warning; EXPIRED or REVOKED error;
//   PENDING_VALIDATION warning with the CNAME to create; FAILED / VALIDATION_TIMED_OUT warning when in use, else unknown
//   "validation failed — unused, safe to delete".
// - Facts: state, notAfter, inUse, autoRenew (propagate R3 warns what an expiring certificate serves; R7 marks an unused
//   one idle).
// No AWS calls and no `server-only`, so node:test runs it (acm.test.ts).
import { awsTime, clip, enrichmentOf, fmtTime, plural, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

const DAY = 86_400_000;

// Every key algorithm: without Includes.keyTypes, ListCertificates returns RSA_1024/RSA_2048 certificates only.
export const ACM_KEY_TYPES = ["RSA_1024", "RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1", "EC_secp521r1"] as const;

export interface AcmValidation {
  DomainName?: string;
  ValidationStatus?: string;
  ValidationMethod?: string;
  ResourceRecord?: { Name?: string; Type?: string; Value?: string };
}

// DescribeCertificate, the parts the map uses.
export interface AcmCertDetail {
  InUseBy?: string[];
  FailureReason?: string;
  DomainValidationOptions?: AcmValidation[];
  RenewalSummary?: { RenewalStatus?: string; RenewalStatusReason?: string; UpdatedAt?: Date | string; DomainValidationOptions?: AcmValidation[] };
  SubjectAlternativeNames?: string[];
  Issuer?: string;
  Serial?: string;
}

// ListCertificates' CertificateSummary, plus what the provider read for it.
export interface RawCert {
  CertificateArn?: string;
  DomainName?: string;
  SubjectAlternativeNameSummaries?: string[];
  HasAdditionalSubjectAlternativeNames?: boolean;
  Status?: string;
  Type?: string; // AMAZON_ISSUED | IMPORTED | PRIVATE
  KeyAlgorithm?: string;
  InUse?: boolean;
  RenewalEligibility?: string; // ELIGIBLE | INELIGIBLE
  NotBefore?: Date | string;
  NotAfter?: Date | string;
  CreatedAt?: Date | string;
  IssuedAt?: Date | string;
  ImportedAt?: Date | string;
  detail?: AcmCertDetail; // undefined = not read (only in-use or problem certificates are described)
  tags?: { Key?: string; Value?: string }[]; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // detail, tags
}

const daysLeft = (c: RawCert, now: number) => {
  const end = awsTime(c.NotAfter);
  return end === undefined ? undefined : Math.floor((end - now) / DAY);
};

// Certificates worth a DescribeCertificate: in use (InUseBy gives the tls links) or in a problem state.
export function needsDetail(c: RawCert, now: number): boolean {
  if (c.InUse) return true;
  if (c.Status !== "ISSUED") return true;
  const left = daysLeft(c, now);
  return left !== undefined && left <= 30;
}

const autoRenews = (c: RawCert) => c.Type !== "IMPORTED" && c.RenewalEligibility === "ELIGIBLE";
const renewalTrouble = (c: RawCert) => /^(FAILED|PENDING_VALIDATION|PENDING_AUTO_RENEWAL)$/.test(c.detail?.RenewalSummary?.RenewalStatus ?? "");

// The CNAME ACM waits for ("_x.example.com. CNAME _y.acm-validations.aws."), first pending one.
function pendingCname(c: RawCert): string | undefined {
  const v = [...(c.detail?.DomainValidationOptions ?? []), ...(c.detail?.RenewalSummary?.DomainValidationOptions ?? [])].find(
    (o) => o.ValidationStatus === "PENDING_VALIDATION" && o.ResourceRecord?.Name,
  );
  return v?.ResourceRecord ? `${v.ResourceRecord.Name} ${v.ResourceRecord.Type ?? "CNAME"} ${v.ResourceRecord.Value ?? ""}`.trim() : undefined;
}

function healthOf(c: RawCert, now: number): { health: Health; reason?: string } {
  const left = daysLeft(c, now);
  const inUse = c.InUse === true;
  switch (c.Status) {
    case "ISSUED": {
      if (left === undefined) return { health: "ok" };
      if (left < 0) return { health: "error", reason: `expired on ${fmtTime(awsTime(c.NotAfter))}` };
      if (left <= 7) return { health: "error", reason: `expires in ${plural(left, "day")}` };
      if (left <= 30 && (!autoRenews(c) || renewalTrouble(c))) {
        const why = c.Type === "IMPORTED" ? "imported — renew it yourself" : c.RenewalEligibility !== "ELIGIBLE" ? "not eligible for automatic renewal" : `renewal ${(c.detail?.RenewalSummary?.RenewalStatus ?? "").toLowerCase().replace(/_/g, " ")}`;
        return { health: "warning", reason: `expires in ${plural(left, "day")} (${why})` };
      }
      return { health: "ok" };
    }
    case "EXPIRED":
      return { health: "error", reason: "expired" };
    case "REVOKED":
      return { health: "error", reason: "revoked" };
    case "PENDING_VALIDATION": {
      const cname = pendingCname(c);
      return { health: "warning", reason: `waiting for validation${cname ? `: create ${cname}` : ""}` };
    }
    case "FAILED":
    case "VALIDATION_TIMED_OUT":
      return inUse ? { health: "warning", reason: `validation failed${c.detail?.FailureReason ? ` (${c.detail.FailureReason})` : ""}` } : { health: "unknown", reason: "validation failed — unused, safe to delete" };
    case "INACTIVE":
      return { health: "stopped", reason: "inactive" };
    default:
      return { health: "unknown", reason: c.Status ? `status ${c.Status}` : "status not reported" };
  }
}

const TYPE: Record<string, string> = { AMAZON_ISSUED: "Amazon-issued", IMPORTED: "Imported", PRIVATE: "Private CA" };
const idOf = (arn: string) => arn.split("/").pop() ?? arn;

export function acmConsoleUrl(region: string, arn: string) {
  return `https://${region}.console.aws.amazon.com/acm/home?region=${region}#/certificates/${encodeURIComponent(idOf(arn))}`;
}

export function acmResult(certs: RawCert[], o: { now: number }): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const c of certs) {
    if (!c.CertificateArn) continue;
    const arn = c.CertificateArn;
    const region = arn.split(":")[3] ?? "";
    const { health, reason } = healthOf(c, o.now);
    const end = awsTime(c.NotAfter);
    const left = daysLeft(c, o.now);
    const facts: Facts = { inUse: c.InUse === true, autoRenew: autoRenews(c) };
    if (c.Status) facts.state = c.Status;
    if (end !== undefined) facts.notAfter = new Date(end).toISOString();
    const users = c.detail?.InUseBy ?? [];
    const sans = (c.detail?.SubjectAlternativeNames ?? c.SubjectAlternativeNameSummaries ?? []).filter((d) => d !== c.DomainName);
    const enrichment = enrichmentOf(c.enrichment);
    resources.push({
      key: arn,
      kind: "acm-certificate",
      provider: "acm",
      name: `${c.DomainName ?? "certificate"} · ${idOf(arn).slice(0, 8)}`,
      region,
      ...tagsOf(c.tags),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Domain", value: c.DomainName },
        { label: "Other names", value: sans.length ? clip(sans.join(", "), 160) + (c.HasAdditionalSubjectAlternativeNames && !c.detail ? " …" : "") : undefined },
        { label: "Type", value: c.Type ? (TYPE[c.Type] ?? c.Type) : undefined },
        { label: "Status", value: c.Status },
        { label: "Expires", value: end !== undefined ? `${fmtTime(end)}${left !== undefined && left >= 0 ? ` (in ${plural(left, "day")})` : ""}` : undefined },
        { label: "Renewal", value: c.Type === "IMPORTED" ? "manual (imported)" : c.RenewalEligibility === "ELIGIBLE" ? `automatic${c.detail?.RenewalSummary?.RenewalStatus ? ` · ${c.detail.RenewalSummary.RenewalStatus}` : ""}` : c.RenewalEligibility ? "not eligible" : undefined },
        {
          label: "In use by",
          value: !c.InUse ? "nothing" : c.detail ? plural(users.length, "resource") : unread("users", c.enrichment?.detail),
        },
        { label: "Key algorithm", value: c.KeyAlgorithm },
        { label: "Failure", value: c.detail?.FailureReason },
      ]),
      consoleUrl: acmConsoleUrl(region, arn),
      ...(c.CreatedAt ?? c.ImportedAt ? { createdAt: awsTime(c.CreatedAt ?? c.ImportedAt) } : {}),
    });
    for (const u of users) links.push({ from: arn, to: u, kind: "tls", label: "serves", evidence: "ACM InUseBy" });
  }
  return { resources, links, mentions: [] };
}

// The panel: domains, validation records, renewal and users (DescribeCertificate, live or simulated).
export function acmDetail(key: string, c: RawCert | undefined): ResourceDetail {
  if (!c) return { key, sections: [{ title: "Certificate", note: "This certificate no longer exists." }] };
  const d = c.detail;
  const v = d?.DomainValidationOptions ?? [];
  const tags = (c.tags ?? []).filter((x) => x.Key);
  return {
    key,
    sections: [
      {
        title: "Certificate",
        rows: props([
          { label: "Domain", value: c.DomainName },
          { label: "Status", value: c.Status },
          { label: "Type", value: c.Type ? (TYPE[c.Type] ?? c.Type) : undefined },
          { label: "Issuer", value: d?.Issuer },
          { label: "Valid from", value: c.NotBefore ? fmtTime(awsTime(c.NotBefore)) : undefined },
          { label: "Valid until", value: c.NotAfter ? fmtTime(awsTime(c.NotAfter)) : undefined },
          { label: "Renewal", value: d?.RenewalSummary?.RenewalStatus ? `${d.RenewalSummary.RenewalStatus}${d.RenewalSummary.RenewalStatusReason ? ` (${d.RenewalSummary.RenewalStatusReason})` : ""}` : c.RenewalEligibility },
          { label: "Failure", value: d?.FailureReason },
          { label: "Key algorithm", value: c.KeyAlgorithm },
        ]),
      },
      ...(v.length
        ? [{ title: "Domain validation", table: { columns: ["Domain", "Method", "Status", "Record"], rows: v.map((o) => [o.DomainName ?? "?", o.ValidationMethod ?? "—", o.ValidationStatus ?? "—", o.ResourceRecord?.Name ? `${o.ResourceRecord.Name} ${o.ResourceRecord.Type ?? ""} ${o.ResourceRecord.Value ?? ""}`.trim() : "—"]) } }]
        : []),
      { title: "In use by", ...(d?.InUseBy?.length ? { table: { columns: ["Resource"], rows: d.InUseBy.map((u) => [u]) } } : { note: c.InUse ? "Not read." : "No AWS service uses this certificate." }) },
      ...(tags.length ? [{ title: "Tags", table: { columns: ["Key", "Value"], rows: tags.map((x) => [x.Key!, x.Value ?? ""]) } }] : []),
    ],
  };
}
