// Certificate Manager provider: ACM certificates with their expiry, renewal, validation and what uses them. Lists with
// Includes.keyTypes set to every key algorithm (the default lists RSA_1024/RSA_2048 only), plus a us-east-1 pass from
// the home run when the console doesn't cover us-east-1 (CloudFront certificates live there). Hands the list to
// ctx.checkpoint, then reads per certificate through enrich() (R18): DescribeCertificate only for certificates in use
// (InUseBy gives the tls links) or in a problem state, first 300; tags for the first 200 (unread tags: tagsUnread, R01).
// Domains go in props only. Read-only: no actions. The mapper is pure (../../inventory/acm.ts).
import "server-only";
import { ACMClient, DescribeCertificateCommand, ListCertificatesCommand, ListTagsForCertificateCommand } from "@aws-sdk/client-acm";
import { ACM_KEY_TYPES, acmDetail, acmResult, needsDetail, type AcmCertDetail, type RawCert } from "../../inventory/acm.ts";
import { parseArn } from "../../inventory/arn.ts";
import { simAcm } from "./mock/acm.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const acm = perRegion((region) => new ACMClient(sdkConfig(region)), "acm");
const CLOUDFRONT_REGION = "us-east-1";
const DETAIL_MAX = 300;
const TAGS_MAX = 200;

// The regions this run lists: its own, plus us-east-1 from the home run when no other run covers it.
function regionsOf(ctx: ProviderContext): string[] {
  const home = ctx.home ?? ctx.region;
  const covered = ctx.regions?.includes(CLOUDFRONT_REGION) ?? false;
  return ctx.region === home && ctx.region !== CLOUDFRONT_REGION && !covered ? [ctx.region, CLOUDFRONT_REGION] : [ctx.region];
}

async function list(ctx: ProviderContext, region: string): Promise<RawCert[]> {
  const c = acm(region);
  return paged(ctx, `acm certificates in ${region}`, async (NextToken) => {
    const r = await c.send(new ListCertificatesCommand({ Includes: { keyTypes: [...ACM_KEY_TYPES] }, MaxItems: 1000, NextToken }), t(ctx));
    return { items: r.CertificateSummaryList as RawCert[] | undefined, next: r.NextToken };
  }, { service: "acm" });
}

// A certificate deleted since the map was built: the panel says so instead of failing.
const gone = (e: unknown) => ((e as { name?: string })?.name === "ResourceNotFoundException" ? undefined : Promise.reject(e));
const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;
const describe = async (arn: string, ctx: ProviderContext) =>
  (await acm(regionOf(arn, ctx.region)).send(new DescribeCertificateCommand({ CertificateArn: arn }), t(ctx))).Certificate as AcmCertDetail | undefined;
const tagsFor = async (arn: string, ctx: ProviderContext) => (await acm(regionOf(arn, ctx.region)).send(new ListTagsForCertificateCommand({ CertificateArn: arn }), t(ctx))).Tags ?? [];

async function fetchCerts(ctx: ProviderContext): Promise<RawCert[]> {
  const [own, ...extra] = regionsOf(ctx);
  const certs = await list(ctx, own);
  for (const r of extra) certs.push(...((await softly(ctx, `acm certificates in ${r}`, { limited: false, service: "acm" })(() => list(ctx, r))) ?? []));
  const now = Date.now();
  const base = certs.filter((x) => x.CertificateArn).map((x): RawCert => ({ ...x, enrichment: { ...(needsDetail(x, now) ? { detail: "skipped" } : {}), tags: "skipped" } }));
  ctx.checkpoint?.(acmResult(base, { now }));
  const until = budget();
  const problem = base.filter((x) => needsDetail(x, now));
  const [details, tags] = await Promise.all([
    enrich(ctx, problem, { label: "acm certificate details", max: DETAIL_MAX, until }, (x) => describe(x.CertificateArn!, ctx)),
    enrich(ctx, base, { label: "acm certificate tags", max: TAGS_MAX, until }, (x) => tagsFor(x.CertificateArn!, ctx)),
  ]);
  const detailOf = new Map(problem.map((x, i) => [x.CertificateArn, { value: details.results[i], state: details.state[i] }]));
  return base.map((x, i) => {
    const d = detailOf.get(x.CertificateArn);
    return {
      ...x,
      ...(d?.value ? { detail: d.value } : {}),
      tags: tags.state[i] === "ok" ? (tags.results[i] ?? []) : undefined,
      enrichment: { ...(d ? { detail: d.state } : {}), tags: tags.state[i] },
    };
  });
}

export const acmProvider: Provider = {
  id: "acm",
  label: "Certificate Manager",
  kinds: ["acm-certificate"],
  scope: "regional",
  covers: ["acm:certificate"],
  ttlMs: 30 * 60_000,
  multiRegionMock: true,
  read: ["acm:ListCertificates", "acm:DescribeCertificate", "acm:ListTagsForCertificate"],
  async discover(ctx) {
    const now = Date.now();
    const certs = ctx.mock ? regionsOf(ctx).flatMap((r) => simAcm(r, now)) : await fetchCerts(ctx);
    return acmResult(certs, { now });
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return acmDetail(r.key, simAcm(region).find((c) => c.CertificateArn === r.key));
    const c = acm(region);
    const [d, tags] = await Promise.all([
      c.send(new DescribeCertificateCommand({ CertificateArn: r.key }), t(ctx)).catch(gone),
      softly(ctx, "acm certificate tags", { service: "acm" })(() => c.send(new ListTagsForCertificateCommand({ CertificateArn: r.key }), t(ctx))),
    ]);
    const x = d?.Certificate;
    if (!x) return acmDetail(r.key, undefined);
    return acmDetail(r.key, {
      CertificateArn: r.key, DomainName: x.DomainName, Status: x.Status, Type: x.Type, KeyAlgorithm: x.KeyAlgorithm, InUse: (x.InUseBy ?? []).length > 0, RenewalEligibility: x.RenewalEligibility,
      NotBefore: x.NotBefore, NotAfter: x.NotAfter, detail: x as AcmCertDetail, tags: tags?.Tags,
    });
  },
};
