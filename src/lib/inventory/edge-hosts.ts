// Hostname rules shared by the edge providers (S3, CloudFront, Route 53, Cloudflare): normalising DNS names, telling
// which AWS service a hostname belongs to, and turning CDN origins / DNS targets into references the inventory
// resolves against resources' keys, endpoints and aliases. Pure — no AWS calls.
import type { Link } from "./types.ts";

// "Dualstack.Name-1.us-east-1.elb.amazonaws.com." → "name-1.us-east-1.elb.amazonaws.com"
export const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "").replace(/^dualstack\./, "");

// Route 53 escapes some characters in names as octal: "\052.acme.example." is "*.acme.example".
export const decodeDnsName = (name: string) => normHost(name.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));

export const isIpv4 = (s: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
export const isIp = (s: string) => isIpv4(s) || (/^[0-9a-f:.]+$/i.test(s) && s.includes(":"));

// Names under a zone (the apex included). "shop.acme-shop.com" is in "acme-shop.com"; "evilacme-shop.com" is not.
export const inZone = (host: string, zone: string) => {
  const h = normHost(host), z = normHost(zone);
  return h === z || h.endsWith(`.${z}`);
};

// Service-owned names that never point at a workload: ACM validation, DKIM, SRV-style "_service._proto" names.
export const plumbingName = (name: string) => normHost(name).split(".").some((l) => l.startsWith("_"));

export type HostKind = "s3" | "s3-website" | "loadbalancer" | "apigateway" | "apigateway-domain" | "cloudfront" | "beanstalk" | "apprunner" | "ip" | "other";
export interface HostInfo {
  kind: HostKind;
  host: string; // normalised
  bucket?: string; // s3, s3-website (absent for the regional website alias target "s3-website-us-east-1.amazonaws.com")
  region?: string;
  name?: string; // load balancer name, Elastic Beanstalk CNAME prefix
  id?: string; // API id, App Runner service id
}

const REGION_RE = "[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\\d";
const AWS = "\\.amazonaws\\.com(?:\\.cn)?";
const RE = {
  s3Website: new RegExp(`^(?:(.+)\\.)?s3-website[.-](${REGION_RE})${AWS}$`),
  s3: new RegExp(`^(.+)\\.s3(?:-accelerate|-external-1)?(?:\\.dualstack)?(?:[.-](${REGION_RE}))?${AWS}$`),
  alb: new RegExp(`^(?:internal-)?(.+)-([0-9a-z]+)\\.(${REGION_RE})\\.elb${AWS}$`), // ALB / classic: name-id.region.elb.amazonaws.com
  nlb: new RegExp(`^(.+)-([0-9a-f]+)\\.elb\\.(${REGION_RE})${AWS}$`), // NLB: name-id.elb.region.amazonaws.com
  apiDomain: new RegExp(`^d-([a-z0-9]{10})\\.execute-api\\.(${REGION_RE})${AWS}$`),
  api: new RegExp(`^([a-z0-9]{10})\\.execute-api\\.(${REGION_RE})${AWS}$`),
  cloudfront: /^[a-z0-9]+\.cloudfront\.net$/,
  beanstalk: new RegExp(`^(.+?)(?:\\.(${REGION_RE}))?\\.elasticbeanstalk\\.com$`),
  apprunner: new RegExp(`^([a-z0-9]+)\\.(${REGION_RE})\\.awsapprunner\\.com$`),
};

export function classifyHost(raw: string): HostInfo {
  const host = normHost(raw);
  let m: RegExpExecArray | null;
  if (isIp(host)) return { kind: "ip", host };
  if ((m = RE.s3Website.exec(host))) return { kind: "s3-website", host, bucket: m[1], region: m[2] };
  if ((m = RE.s3.exec(host))) return { kind: "s3", host, bucket: m[1], region: m[2] };
  if ((m = RE.apiDomain.exec(host))) return { kind: "apigateway-domain", host, id: m[1], region: m[2] };
  if ((m = RE.api.exec(host))) return { kind: "apigateway", host, id: m[1], region: m[2] };
  if ((m = RE.nlb.exec(host))) return { kind: "loadbalancer", host, name: m[1], region: m[3] };
  if ((m = RE.alb.exec(host))) return { kind: "loadbalancer", host, name: m[1], region: m[3] };
  if (RE.cloudfront.test(host)) return { kind: "cloudfront", host };
  if ((m = RE.beanstalk.exec(host))) return { kind: "beanstalk", host, name: m[1], region: m[2] };
  if ((m = RE.apprunner.exec(host))) return { kind: "apprunner", host, id: m[1], region: m[2] };
  return { kind: "other", host };
}

export const bucketArn = (bucket: string) => `arn:aws:s3:::${bucket}`;

// A CDN origin domain → what the inventory should resolve: the bucket's key for S3 (REST or website endpoint, any
// region), the normalised hostname for everything else (ALB DNS, API Gateway domain, a custom origin).
export function originRef(domain: string): string {
  const h = classifyHost(domain);
  return (h.kind === "s3" || h.kind === "s3-website") && h.bucket ? bucketArn(h.bucket) : h.host;
}

// A DNS record's target → reference. S3 website aliases point at the regional endpoint ("s3-website-us-east-1…"), and
// the bucket must be named like the record, so the record name identifies it. Everything else by hostname (API Gateway
// custom domains alias to their regional "d-…execute-api" name, which the API lists among its endpoints).
export function dnsTargetRef(recordName: string, target: string): string {
  const h = classifyHost(target);
  if (h.kind === "s3-website") return bucketArn(h.bucket ?? normHost(recordName));
  if (h.kind === "s3" && h.bucket) return bucketArn(h.bucket);
  return h.host;
}

// Regions whose website endpoint uses a dash ("s3-website-us-east-1"); every newer region uses a dot.
const WEBSITE_DASH = new Set(["us-east-1", "us-west-1", "us-west-2", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "eu-west-1", "sa-east-1", "us-gov-west-1"]);
export const websiteEndpoint = (bucket: string, region: string) =>
  `${bucket}.s3-website${WEBSITE_DASH.has(region) ? "-" : "."}${region}.amazonaws.com`;

// Hostnames a bucket answers on (the inventory matches origins, DNS targets and env values against them).
export const s3Endpoints = (bucket: string, region: string, website: boolean) =>
  [`${bucket}.s3.${region}.amazonaws.com`, `${bucket}.s3.amazonaws.com`, ...(website ? [websiteEndpoint(bucket, region)] : [])];

// "arn:aws:lambda:us-east-1:1:function:thumb:3" (a version or alias) → the function's own ARN.
export const lambdaFunctionArn = (arn: string) => (/^arn:aws[a-z-]*:lambda:/.test(arn) ? arn.split(":").slice(0, 7).join(":") : arn);

// SigV4 wants every byte outside A-Z a-z 0-9 - _ . ~ percent-encoded (encodeURIComponent leaves !'()* alone).
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const s3KeyPath = (key: string) => key.split("/").map(rfc3986).join("/");

// Virtual-hosted style, except for dotted names (TLS certificates cover one label only) → path style.
export const s3ObjectUrl = (bucket: string, region: string, key: string) =>
  bucket.includes(".")
    ? { host: `s3.${region}.amazonaws.com`, path: `/${rfc3986(bucket)}/${s3KeyPath(key)}` }
    : { host: `${bucket}.s3.${region}.amazonaws.com`, path: `/${s3KeyPath(key)}` };

// Several records often point at the same place (A + AAAA, weighted sets, apex + www): one link per from/to/kind, labels
// merged — or, with byLabel, one per label too (DNS: the inventory learns the record name from each link's label).
export function mergeLinks(links: Link[], maxLabels = 3, byLabel = false): Link[] {
  const byId = new Map<string, { link: Link; labels: string[]; evidence: string[] }>();
  for (const l of links) {
    const id = `${l.from}->${l.to}:${l.kind}${byLabel ? `|${l.label ?? ""}` : ""}`;
    const cur = byId.get(id) ?? { link: { ...l }, labels: [], evidence: [] };
    if (l.label && !cur.labels.includes(l.label)) cur.labels.push(l.label);
    if (!cur.evidence.includes(l.evidence)) cur.evidence.push(l.evidence);
    byId.set(id, cur);
  }
  const clip = (xs: string[], sep: string) => (xs.length > maxLabels ? `${xs.slice(0, maxLabels).join(sep)} +${xs.length - maxLabels} more` : xs.join(sep));
  return [...byId.values()].map(({ link, labels, evidence }) => ({
    ...link,
    label: labels.length ? clip(labels, ", ") : undefined,
    evidence: clip(evidence, "; "),
  }));
}
