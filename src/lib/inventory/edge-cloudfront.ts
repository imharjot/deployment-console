// CloudFront as the cloud map sees it: the raw distribution shape the real and simulated sources return, the rules
// that turn it into a Resource plus Links (origins → S3 / ALB / API Gateway / custom hosts, labelled with the path
// patterns that reach them; access logs → a bucket; Lambda@Edge → functions; its ACM certificate → it (tls); its WAFv2
// web ACL → it (protects)), and invalidation-path validation. Pure — no AWS calls.
import { lambdaFunctionArn, normHost, originRef, classifyHost } from "./edge-hosts.ts";
import type { Io } from "./edge-s3.ts";
import type { EnrichState, Link, Prop, Resource } from "./types.ts";

export interface RawOrigin {
  id: string;
  domain: string;
  path?: string;
  type: "s3" | "custom" | "vpc";
  protocol?: string; // custom origins: "https-only" | "http-only" | "match-viewer"
  oac?: boolean; // S3 origin access control
}
export interface RawBehavior {
  pattern: string; // "*" for the default behaviour
  originId: string; // an origin or an origin group
  viewerProtocol?: string;
  cachePolicyId?: string;
  edgeLambdas: { arn: string; event: string }[];
  functions: { arn: string; event: string }[]; // CloudFront Functions
}
export interface RawDistribution {
  id: string;
  arn: string;
  domain: string; // d123.cloudfront.net
  aliases: string[]; // CNAMEs
  enabled: boolean;
  status: string; // "Deployed" | "InProgress"
  comment?: string;
  priceClass?: string;
  webAclId?: string;
  httpVersion?: string;
  certificate?: string; // ACM ARN, IAM cert id, or "CloudFront default"
  staging?: boolean; // a continuous-deployment staging distribution
  origins: RawOrigin[];
  originGroups: { id: string; members: string[] }[];
  behaviors: RawBehavior[]; // default first
  logging?: { bucket: string; prefix: string }; // standard (legacy) logging to S3
  tags?: Record<string, string>; // undefined until read (ListTagsForResource)
  lastModified?: number;
  unread: string[]; // "tags", "logging" — couldn't be read
}
export interface RawInvalidation {
  id: string;
  status: string; // "InProgress" | "Completed"
  createdAt?: number;
  paths?: string[];
}

export interface CloudFrontApi {
  distributions(io: Io, cap: number): Promise<{ items: RawDistribution[]; truncated: boolean }>; // the list (no tags, no logging)
  tags(arn: string, io?: Io): Promise<Record<string, string>>; // per distribution, and live before a write (R01)
  logging(id: string, io: Io): Promise<RawDistribution["logging"] | null>; // GetDistributionConfig: null = logging off
  config(id: string, io: Io): Promise<RawDistribution | undefined>; // one distribution's origins and behaviours (panel)
  invalidations(id: string, io: Io): Promise<RawInvalidation[]>;
  invalidate(id: string, paths: string[], callerReference: string): Promise<{ id: string; status: string }>;
}

// "/api/*, /v2/* → alb", "default → assets" (at most three patterns, then "+n more").
export function pathLabel(patterns: string[], originId: string, max = 3): string {
  const names = patterns.map((p) => (p === "*" ? "default" : p));
  const list = names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max} more` : names.join(", ");
  return `${list || "unused"} → ${originId}`;
}

// Path patterns per origin, through origin groups (failover pairs get the group's patterns).
export function patternsByOrigin(d: Pick<RawDistribution, "behaviors" | "originGroups">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const groups = new Map(d.originGroups.map((g) => [g.id, g.members]));
  for (const b of d.behaviors) {
    for (const o of groups.get(b.originId) ?? [b.originId]) {
      const list = out.get(o) ?? [];
      if (!list.includes(b.pattern)) list.push(b.pattern);
      out.set(o, list);
    }
  }
  return out;
}

const PRICE: Record<string, string> = {
  PriceClass_100: "100 (North America, Europe)",
  PriceClass_200: "200 (+ Asia, Middle East, Africa)",
  PriceClass_All: "All edge locations",
};
const originKind = (o: RawOrigin) => {
  const h = classifyHost(o.domain);
  if (h.kind === "s3") return o.oac ? "S3, origin access control" : "S3";
  if (h.kind === "s3-website") return "S3 website";
  if (o.type === "vpc") return "VPC origin";
  return `custom, ${o.protocol ?? "https-only"}`;
};

// F41: aliases[0], else the Name tag, else the comment, else the id.
export const distributionName = (d: Pick<RawDistribution, "id" | "aliases" | "comment" | "tags">) =>
  d.aliases[0] || d.tags?.Name?.trim() || d.comment?.trim().slice(0, 60) || d.id;

// A WAFv2 web ACL ARN (classic WAF ids aren't ARNs and no provider lists them).
const isWafV2 = (id?: string) => !!id && /^arn:aws[a-z-]*:wafv2:/.test(id);
const isAcm = (cert?: string) => !!cert && /^arn:aws[a-z-]*:acm:/.test(cert);

// `state`: how discovery's per-distribution reads went (tags, logging); absent = not attempted (a checkpointed list).
export function distributionResource(d: RawDistribution, state?: Record<string, EnrichState>): { resource: Resource; links: Link[] } {
  const links: Link[] = [];
  const byOrigin = patternsByOrigin(d);
  const failover = new Set(d.originGroups.flatMap((g) => g.members.slice(1)));
  for (const o of d.origins) {
    const patterns = byOrigin.get(o.id) ?? [];
    links.push({
      from: d.arn,
      to: originRef(o.domain),
      kind: "route",
      label: pathLabel(patterns, o.id) + (failover.has(o.id) ? " (failover)" : ""),
      evidence: `CloudFront origin ${o.id} (${originKind(o)})${o.path ? ` path ${o.path}` : ""}${patterns.length ? "" : " — no behaviour uses it"}`,
    });
  }
  if (d.logging) links.push({ from: d.arn, to: originRef(d.logging.bucket), kind: "writes", label: "access logs", evidence: `standard logging → ${normHost(d.logging.bucket).replace(/\.s3[.-].*$/, "")}/${d.logging.prefix}` });
  const lambdas = new Map<string, Set<string>>();
  for (const b of d.behaviors) for (const l of b.edgeLambdas) lambdas.set(lambdaFunctionArn(l.arn), (lambdas.get(lambdaFunctionArn(l.arn)) ?? new Set()).add(l.event));
  for (const [arn, events] of lambdas) links.push({ from: d.arn, to: arn, kind: "invoke", label: [...events].join(", "), evidence: `Lambda@Edge on ${[...events].join(", ")}` });
  if (isAcm(d.certificate)) links.push({ from: d.certificate!, to: d.arn, kind: "tls", label: "viewer certificate", evidence: "ViewerCertificate.ACMCertificateArn" });
  if (isWafV2(d.webAclId)) links.push({ from: d.webAclId!, to: d.arn, kind: "protects", label: "web ACL", evidence: "distribution WebACLId (WAFv2)" });

  const props: Prop[] = [
    { label: "Domain", value: d.domain, mono: true },
    ...(d.aliases.length ? [{ label: "Aliases", value: d.aliases.join(", "), mono: true }] : []),
    { label: "Status", value: `${d.enabled ? "Enabled" : "Disabled"} · ${d.status}` },
    { label: "Origins", value: d.origins.map((o) => o.id).join(", ") || "none" },
    ...(d.priceClass ? [{ label: "Price class", value: PRICE[d.priceClass] ?? d.priceClass }] : []),
    { label: "WAF", value: d.webAclId ? d.webAclId.replace(/^arn:aws:wafv2:[^:]*:\d*:global\/webacl\/([^/]+)\/.*$/, "$1") : "none", mono: !!d.webAclId },
    ...(d.certificate ? [{ label: "Certificate", value: d.certificate, mono: d.certificate.startsWith("arn:") }] : []),
    ...(d.logging ? [{ label: "Access logs", value: `${normHost(d.logging.bucket).replace(/\.s3[.-].*$/, "")}/${d.logging.prefix}`, mono: true }] : []),
    ...(d.httpVersion ? [{ label: "HTTP", value: d.httpVersion }] : []),
    ...(d.staging ? [{ label: "Staging", value: "continuous-deployment staging distribution" }] : []),
    ...(d.comment ? [{ label: "Comment", value: d.comment }] : []),
    ...(d.unread.length ? [{ label: "Not readable", value: d.unread.join(", ") }] : []),
  ];
  const fns = [...new Set(d.behaviors.flatMap((b) => b.functions.map((f) => `${f.arn.split("/").pop()} (${f.event})`)))];
  if (fns.length) props.push({ label: "Functions", value: fns.join(", ") });

  return {
    resource: {
      key: d.arn,
      kind: "cloudfront",
      provider: "cloudfront",
      name: distributionName(d),
      region: "global",
      tags: d.tags ?? {},
      ...(d.tags === undefined ? { tagsUnread: true } : {}), // R01: not read ≠ none
      ...(state ? { enrichment: { ...state } } : {}),
      health: d.enabled ? "ok" : "stopped",
      healthReason: !d.enabled ? "distribution is disabled" : d.status === "InProgress" ? "deploying a configuration change" : undefined,
      props,
      endpoints: [d.domain, ...d.aliases].map(normHost),
      aliases: [d.id, ...d.aliases.map(normHost)],
      consoleUrl: `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${d.id}`,
      lastModified: d.lastModified,
    },
    links,
  };
}

// Invalidation paths: 1–30, each starting with "/", "*" only as the last character, no spaces or control characters
// (URL-encode them). Duplicates are dropped.
export function invalidationPathsError(paths: unknown): string | undefined {
  if (!Array.isArray(paths) || !paths.length) return "give at least one path";
  if (paths.length > 30) return "at most 30 paths per invalidation";
  for (const p of paths) {
    if (typeof p !== "string" || !p.startsWith("/")) return `each path must start with / (got ${JSON.stringify(p).slice(0, 60)})`;
    if (p.length > 4000) return "a path is longer than 4,000 characters";
    if (/[\s\u0000-\u001f\u007f]/.test(p)) return `URL-encode spaces and control characters in ${JSON.stringify(p).slice(0, 60)}`;
    const star = p.indexOf("*");
    if (star >= 0 && star !== p.length - 1) return `"*" may only end a path (${p.slice(0, 60)})`;
  }
  return undefined;
}
export const cleanPaths = (paths: string[]) => [...new Set(paths)];
