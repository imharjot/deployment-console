// Simulated Route 53 for the Acme demo account: the public zone acme.example, whose records point at the shop and
// staging distributions, the production ALB, the public API Gateway custom domain, the bastion's public IP and the
// legacy Elastic Beanstalk admin — plus the usual mail, SPF and certificate-validation records the map ignores — and the
// private zone Cloud Map created for acme.internal. The
// API record is a failover primary tied to the health check on api.acme.example (all checkers report success). Like
// the real API, the lists carry no tags or VPCs: those come from their own calls.
import type { RawHealthCheck, RawRecord, RawZone, Route53Api } from "../../../inventory/edge-dns.ts";
import { APIGW, BEANSTALK, CLOUDFRONT, CLOUDMAP, EC2, EXISTING, HEALTH_CHECK, REGION, ROUTE53 } from "../mock-names.ts";
import { PUBLIC_DOMAIN_TARGET } from "./apigateway.ts";

const Z = ROUTE53.zone.name;
const CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2"; // alias hosted-zone ids AWS publishes
const ELB_ZONE = "Z35SXDOTRQ7X7K";
const APIGW_ZONE = "Z1UJRXOUMOOFQ8";

export const MOCK_RECORDS: RawRecord[] = [
  { name: Z, type: "NS", ttl: 172800, values: ["ns-1203.awsdns-22.org.", "ns-310.awsdns-38.com.", "ns-1812.awsdns-34.co.uk.", "ns-903.awsdns-48.net."] },
  { name: Z, type: "SOA", ttl: 900, values: ["ns-1203.awsdns-22.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400"] },
  { name: Z, type: "MX", ttl: 300, values: ["10 inbound-smtp.us-east-1.amazonaws.com"] },
  { name: Z, type: "TXT", ttl: 300, values: ['"v=spf1 include:amazonses.com ~all"'] },
  { name: `_3f1a2b4c5d6e.${Z}`, type: "CNAME", ttl: 300, values: ["_9c8d7e6f5a4b.acm-validations.aws."] },
  { name: `www.${Z}`, type: "A", values: [], alias: { target: `${CLOUDFRONT.shop.domain}.`, zoneId: CLOUDFRONT_ZONE, evaluateHealth: false } },
  { name: `www.${Z}`, type: "AAAA", values: [], alias: { target: `${CLOUDFRONT.shop.domain}.`, zoneId: CLOUDFRONT_ZONE, evaluateHealth: false } },
  {
    name: `api.${Z}`, type: "A", values: [], alias: { target: `dualstack.${EXISTING.alb.dns}.`, zoneId: ELB_ZONE, evaluateHealth: true },
    setId: "api-primary", failover: "PRIMARY", healthCheckId: HEALTH_CHECK.id,
  },
  { name: APIGW.publicHttp.customDomain, type: "A", values: [], alias: { target: `${PUBLIC_DOMAIN_TARGET}.`, zoneId: APIGW_ZONE, evaluateHealth: false } },
  { name: `staging.${Z}`, type: "A", values: [], alias: { target: `${CLOUDFRONT.staging.domain}.`, zoneId: CLOUDFRONT_ZONE, evaluateHealth: false } },
  { name: `bastion.${Z}`, type: "A", ttl: 300, values: [EC2.bastion.publicIp] },
  { name: `legacy-admin.${Z}`, type: "CNAME", ttl: 300, values: [BEANSTALK.env.cname] },
];

// The private zone Cloud Map created for its namespace acme.internal (mock-names CLOUDMAP): its records are Cloud Map's
// to manage (the services' A records come and go with the tasks), so the simulation lists only its NS and SOA.
const NS_ZONE = CLOUDMAP.namespace;
const INTERNAL_RECORDS: RawRecord[] = [
  { name: NS_ZONE.name, type: "NS", ttl: 172800, values: ["ns-1536.awsdns-00.co.uk.", "ns-0.awsdns-00.com.", "ns-1024.awsdns-00.org.", "ns-512.awsdns-00.net."] },
  { name: NS_ZONE.name, type: "SOA", ttl: 900, values: ["ns-1536.awsdns-00.co.uk. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400"] },
];

export const MOCK_ZONES: RawZone[] = [
  { id: ROUTE53.zone.id, name: Z, private: false, recordCount: MOCK_RECORDS.length, comment: "Acme public zone" },
  { id: NS_ZONE.hostedZoneId, name: NS_ZONE.name, private: true, recordCount: INTERNAL_RECORDS.length, comment: "Created by Route 53 Auto Naming", linkedService: "servicediscovery.amazonaws.com" },
];
const ZONE_TAGS: Record<string, Record<string, string>> = { [ROUTE53.zone.id]: { Owner: "platform" } };

export const MOCK_HEALTH_CHECKS: RawHealthCheck[] = [
  { id: HEALTH_CHECK.id, type: "HTTPS", fqdn: HEALTH_CHECK.fqdn, port: 443, path: "/health", interval: 30, failureThreshold: 3, checkerRegions: [], inverted: false, disabled: false },
];
const CHECK_TAGS: Record<string, Record<string, string>> = { [HEALTH_CHECK.id]: { Name: "acme-api-health", Environment: "production" } };
// Route 53 checks from eight regions by default: all report success.
const CHECKERS = ["us-east-1", "us-west-1", "us-west-2", "eu-west-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "sa-east-1"];

export const mockRoute53: Route53Api = {
  async zones(_io, cap) {
    return { zones: MOCK_ZONES.slice(0, cap).map((z) => ({ ...z })), truncated: MOCK_ZONES.length > cap };
  },
  async zoneVpcs(zoneId) {
    return zoneId === NS_ZONE.hostedZoneId ? [{ id: NS_ZONE.vpc, region: REGION }] : [];
  },
  async tags(type, ids) {
    const all = type === "hostedzone" ? ZONE_TAGS : CHECK_TAGS;
    return Object.fromEntries(ids.map((id) => [id, { ...(all[id] ?? {}) }]));
  },
  async records(zoneId, _io, cap) {
    const all = zoneId === ROUTE53.zone.id ? MOCK_RECORDS : zoneId === NS_ZONE.hostedZoneId ? INTERNAL_RECORDS : [];
    return { records: all.slice(0, cap), truncated: all.length > cap };
  },
  async nameServers(zoneId) {
    const ns = zoneId === ROUTE53.zone.id ? MOCK_RECORDS[0] : zoneId === NS_ZONE.hostedZoneId ? INTERNAL_RECORDS[0] : undefined;
    return ns ? ns.values.map((v) => v.replace(/\.$/, "")) : [];
  },
  async healthChecks(_io, cap) {
    return { checks: MOCK_HEALTH_CHECKS.slice(0, cap).map((h) => ({ ...h })), truncated: MOCK_HEALTH_CHECKS.length > cap };
  },
  async healthStatus(id) {
    if (!MOCK_HEALTH_CHECKS.some((h) => h.id === id)) throw Object.assign(new Error("NoSuchHealthCheck: no health check with this id"), { name: "NoSuchHealthCheck" });
    return CHECKERS.map(() => "Success: HTTP Status Code 200, OK");
  },
};
