// Simulated CloudFront for the Acme demo account: the shop distribution (assets bucket by default, /api/* to the
// production ALB, access logs to the logs bucket, two aliases, the CloudFront ACM certificate and web ACL) and the
// staging distribution (a custom origin on the staging box). Like the real API, the list carries neither tags nor
// logging settings: those come from their own calls. Invalidations are kept on globalThis and complete after 45 seconds.
import type { CloudFrontApi, RawDistribution, RawInvalidation } from "../../../inventory/edge-cloudfront.ts";
import { ACCT, ACM_CERTS, CLOUDFRONT, EXISTING, S3, WAF } from "../mock-names.ts";

const DAY = 86_400_000;
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"; // AWS managed cache policies
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const arn = (id: string) => `arn:aws:cloudfront::${ACCT}:distribution/${id}`;
const T0 = Date.now();

export const MOCK_DISTRIBUTIONS: RawDistribution[] = [
  {
    id: CLOUDFRONT.shop.id, arn: arn(CLOUDFRONT.shop.id), domain: CLOUDFRONT.shop.domain, aliases: CLOUDFRONT.shop.aliases,
    enabled: true, status: "Deployed", comment: "Acme shop: storefront assets + API", priceClass: "PriceClass_100",
    webAclId: WAF.cloudfront.arn,
    httpVersion: "http2and3", certificate: ACM_CERTS.cloudfront.arn,
    origins: [
      { id: "assets", domain: S3.assets.domain, type: "s3", oac: true },
      { id: "alb", domain: EXISTING.alb.dns, type: "custom", protocol: "https-only" },
    ],
    originGroups: [],
    behaviors: [
      { pattern: "*", originId: "assets", viewerProtocol: "redirect-to-https", cachePolicyId: CACHING_OPTIMIZED, edgeLambdas: [], functions: [{ arn: `arn:aws:cloudfront::${ACCT}:function/acme-url-rewrite`, event: "viewer-request" }] },
      { pattern: "/api/*", originId: "alb", viewerProtocol: "https-only", cachePolicyId: CACHING_DISABLED, edgeLambdas: [], functions: [] },
    ],
    logging: { bucket: `${S3.logs.name}.s3.amazonaws.com`, prefix: "cloudfront/shop/" },
    tags: { Environment: "production" }, lastModified: T0 - 12 * DAY, unread: [],
  },
  {
    id: CLOUDFRONT.staging.id, arn: arn(CLOUDFRONT.staging.id), domain: CLOUDFRONT.staging.domain, aliases: CLOUDFRONT.staging.aliases,
    enabled: true, status: "Deployed", comment: "Acme staging (Caddy on the staging box)", priceClass: "PriceClass_100",
    httpVersion: "http2", certificate: ACM_CERTS.cloudfront.arn, // the CloudFront certificate also names staging.acme.example
    origins: [{ id: "staging-box", domain: "staging-origin.acme.example", type: "custom", protocol: "https-only" }],
    originGroups: [],
    behaviors: [{ pattern: "*", originId: "staging-box", viewerProtocol: "redirect-to-https", cachePolicyId: CACHING_DISABLED, edgeLambdas: [], functions: [] }],
    tags: { Environment: "staging" }, lastModified: T0 - 40 * DAY, unread: [],
  },
];

const g = globalThis as { __edgeMockInvalidations?: Map<string, RawInvalidation[]> };
const state = () =>
  (g.__edgeMockInvalidations ??= new Map([[CLOUDFRONT.shop.id, [{ id: "I2ACMEDEPLOY01", status: "Completed", createdAt: Date.now() - 3 * DAY, paths: ["/index.html", "/static/*"] }]]]));

const find = (id: string) => {
  const d = MOCK_DISTRIBUTIONS.find((x) => x.id === id || x.arn === id);
  if (!d) throw Object.assign(new Error("NoSuchDistribution: The specified distribution does not exist."), { name: "NoSuchDistribution" });
  return d;
};

export const mockCloudFront: CloudFrontApi = {
  async distributions(_io, cap) {
    const items = MOCK_DISTRIBUTIONS.slice(0, cap).map((d) => ({ ...d, tags: undefined, logging: undefined, unread: [] }));
    return { items, truncated: MOCK_DISTRIBUTIONS.length > cap };
  },
  async tags(arn) {
    return { ...(find(arn).tags ?? {}) };
  },
  async logging(id) {
    return find(id).logging ?? null;
  },
  async config(id) {
    return MOCK_DISTRIBUTIONS.find((d) => d.id === id);
  },
  async invalidations(id) {
    const now = Date.now();
    return (state().get(id) ?? []).map((i) => ({ ...i, status: i.status === "InProgress" && now - (i.createdAt ?? 0) > 45_000 ? "Completed" : i.status })).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },
  async invalidate(id, paths) {
    if (!MOCK_DISTRIBUTIONS.some((d) => d.id === id)) throw Object.assign(new Error("NoSuchDistribution: The specified distribution does not exist."), { name: "NoSuchDistribution" });
    const inv = { id: `I${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`, status: "InProgress", createdAt: Date.now(), paths };
    state().set(id, [inv, ...(state().get(id) ?? [])].slice(0, 20));
    return { id: inv.id, status: inv.status };
  },
};
