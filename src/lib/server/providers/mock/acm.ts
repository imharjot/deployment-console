// Simulated ACM certificates of the Acme account (names from ../mock-names.ts), as ListCertificates summaries plus the
// DescribeCertificate and tag reads the provider makes, per region. us-east-1: the wildcard on the production ALB, the
// shop's CloudFront certificate (CloudFront only takes us-east-1 certificates), the public API's custom-domain
// certificate (./apigateway.ts), and one whose DNS validation failed and
// that nothing uses ("validation failed — unused, safe to delete"; idle). eu-west-1: the EU certificate, issued and
// not attached yet (idle). Other regions: none. Read-only.
import type { RawCert } from "../../../inventory/acm.ts";
import { ACCT, ACM_CERTS, CLOUDFRONT, EU_REGION, EXISTING, REGION } from "../mock-names.ts";
import { PUBLIC_DOMAIN_CERT } from "./apigateway.ts";
import { DAY } from "./serverless-sim.ts";

const DNS = (domain: string, status: string) => ({
  DomainName: domain, ValidationMethod: "DNS", ValidationStatus: status,
  ResourceRecord: { Name: `_0acme${domain.length}.${domain.replace(/^\*\./, "")}.`, Type: "CNAME", Value: `_0acme${domain.length}x.acm-validations.aws.` },
});

export function simAcm(region: string, now: number = Date.now()): RawCert[] {
  const issued = (c: { arn: string; domain: string }, o: Partial<RawCert>): RawCert => ({
    CertificateArn: c.arn, DomainName: c.domain, SubjectAlternativeNameSummaries: [c.domain], HasAdditionalSubjectAlternativeNames: false, Status: "ISSUED", Type: "AMAZON_ISSUED",
    KeyAlgorithm: "RSA-2048", RenewalEligibility: "ELIGIBLE", NotBefore: new Date(now - 100 * DAY), NotAfter: new Date(now + 295 * DAY), CreatedAt: new Date(now - 100 * DAY), IssuedAt: new Date(now - 100 * DAY),
    tags: [{ Key: "Environment", Value: "production" }], enrichment: { detail: "ok", tags: "ok" }, ...o,
  });
  if (region === EU_REGION) return [issued(ACM_CERTS.eu, { InUse: false, detail: undefined, enrichment: { tags: "ok" } })];
  if (region !== REGION) return [];
  return [
    issued(ACM_CERTS.alb, {
      SubjectAlternativeNameSummaries: [ACM_CERTS.alb.domain, "acme.dev"], InUse: true, RenewalEligibility: "ELIGIBLE",
      detail: { InUseBy: [EXISTING.alb.arn], DomainValidationOptions: [DNS(ACM_CERTS.alb.domain, "SUCCESS")], SubjectAlternativeNames: [ACM_CERTS.alb.domain, "acme.dev"], Issuer: "Amazon", RenewalSummary: undefined },
    }),
    // The public API's custom domain (./apigateway.ts), a regional API Gateway domain name.
    issued(PUBLIC_DOMAIN_CERT, {
      InUse: true, NotAfter: new Date(now + 180 * DAY),
      detail: { InUseBy: [`arn:aws:apigateway:${REGION}::/domainnames/${PUBLIC_DOMAIN_CERT.domain}`], DomainValidationOptions: [DNS(PUBLIC_DOMAIN_CERT.domain, "SUCCESS")], Issuer: "Amazon" },
    }),
    issued(ACM_CERTS.cloudfront, {
      InUse: true, NotAfter: new Date(now + 210 * DAY),
      detail: { InUseBy: [`arn:aws:cloudfront::${ACCT}:distribution/${CLOUDFRONT.shop.id}`], DomainValidationOptions: [DNS(ACM_CERTS.cloudfront.domain, "SUCCESS")], Issuer: "Amazon" },
    }),
    {
      CertificateArn: ACM_CERTS.failed.arn, DomainName: ACM_CERTS.failed.domain, SubjectAlternativeNameSummaries: [ACM_CERTS.failed.domain], Status: "FAILED", Type: "AMAZON_ISSUED",
      KeyAlgorithm: "RSA-2048", InUse: false, RenewalEligibility: "INELIGIBLE", CreatedAt: new Date(now - 40 * DAY), tags: [], enrichment: { detail: "ok", tags: "ok" },
      detail: { InUseBy: [], FailureReason: "OTHER", DomainValidationOptions: [DNS(ACM_CERTS.failed.domain, "FAILED")] },
    },
  ];
}
