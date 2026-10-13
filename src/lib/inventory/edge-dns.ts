// DNS as the cloud map sees it — Route 53 hosted zones and health checks, and Cloudflare zones: the raw shapes the real
// and simulated sources return, the rules that turn zones into Resources and records into Links (zone → whatever the
// record points at: a load balancer, a distribution, an API, a bucket website, an instance's IP, another zone — with
// the record's routing policy, so a weighted or failover name keeps every target, R15), Route 53 health checks
// (health from what their checkers report, → what they watch), and Cloudflare cache-purge validation. Pure — no
// network calls.
import { arnOf } from "./arn.ts";
import { decodeDnsName, dnsTargetRef, inZone, isIp, mergeLinks, normHost, plumbingName } from "./edge-hosts.ts";
import type { Io } from "./edge-s3.ts";
import type { EnrichState, Health, Link, Prop, Resource, Routing } from "./types.ts";

// ---- Route 53 ----

export interface RawZone {
  id: string; // "Z0ACMEEXAMPLE" (no "/hostedzone/" prefix)
  name: string; // "acme.example"
  private: boolean;
  recordCount?: number;
  comment?: string;
  linkedService?: string; // LinkedService.ServicePrincipal: "servicediscovery.amazonaws.com" when Cloud Map created it
  vpcs?: { id: string; region: string }[]; // private zones, when read (GetHostedZone)
  tags?: Record<string, string>; // undefined until read
}
export interface RawRecord {
  name: string; // decoded, no trailing dot
  type: string;
  ttl?: number;
  values: string[];
  alias?: { target: string; zoneId?: string; evaluateHealth?: boolean };
  setId?: string; // SetIdentifier: one record of several with the same name and type
  // Routing policy fields, as Route 53 returns them (at most one is set):
  weight?: number;
  failover?: string; // PRIMARY | SECONDARY
  latencyRegion?: string;
  geolocation?: string; // "DE", "EU", "US-CA", "*" (default)
  geoproximity?: string; // an AWS region, a Local Zone or "lat,long"
  cidr?: string; // CidrRoutingConfig: "<collection>/<location>"
  multivalue?: boolean;
  healthCheckId?: string;
  routing?: string; // pre-formatted ("weighted 10", "failover PRIMARY") — used when the fields above aren't given
}
export interface Route53Api {
  zones(io: Io, cap: number): Promise<{ zones: RawZone[]; truncated: boolean }>; // the list only
  zoneVpcs(zoneId: string, io: Io): Promise<{ id: string; region: string }[]>; // a private zone's VPCs (GetHostedZone)
  tags(type: "hostedzone" | "healthcheck", ids: string[], io: Io): Promise<Record<string, Record<string, string>>>; // ≤ 10 ids per call
  records(zoneId: string, io: Io, cap: number): Promise<{ records: RawRecord[]; truncated: boolean }>;
  nameServers(zoneId: string, io: Io): Promise<string[]>;
  healthChecks(io: Io, cap: number): Promise<{ checks: RawHealthCheck[]; truncated: boolean }>;
  healthStatus(id: string, io: Io): Promise<string[]>; // each checker's last StatusReport.Status ("Success: HTTP Status Code 200, OK")
}

export const zoneKey = (id: string) => `arn:aws:route53:::hostedzone/${id.replace(/^\/?hostedzone\//, "")}`;
export const zoneIdOf = (id: string) => id.replace(/^\/?hostedzone\//, "");
const byCloudMap = (svc?: string) => !!svc && /servicediscovery/i.test(svc);

export function zoneResource(z: RawZone, region: string, state?: Record<string, EnrichState>): Resource {
  const vpcs = z.vpcs ?? [];
  const local = vpcs.filter((v) => v.region === region);
  const props: Prop[] = [
    { label: "Type", value: z.private ? "Private" : "Public" },
    { label: "Zone id", value: z.id, mono: true },
    ...(z.recordCount !== undefined ? [{ label: "Records", value: z.recordCount.toLocaleString("en-US") }] : []),
    ...(z.private ? [{ label: "VPCs", value: vpcs.map((v) => `${v.id} (${v.region})`).join(", ") || "unknown", mono: true }] : []),
    ...(byCloudMap(z.linkedService) ? [{ label: "Managed by", value: "Cloud Map (service discovery creates and edits its records)" }] : []),
    ...(z.comment ? [{ label: "Comment", value: z.comment }] : []),
  ];
  return {
    key: zoneKey(z.id),
    kind: "route53-zone",
    provider: "route53",
    name: z.name,
    region: "global",
    tags: z.tags ?? {},
    ...(z.tags === undefined ? { tagsUnread: true } : {}), // R01: not read ≠ none
    ...(state ? { enrichment: { ...state } } : {}),
    health: "ok",
    props,
    vpcId: local.length === 1 ? local[0].id : undefined,
    // Not the zone name: a hostname equal to the apex belongs to whatever the apex record points at, not the zone.
    aliases: [z.id],
    consoleUrl: `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${z.id}`,
  };
}

// R15: how a record set splits traffic, from Route 53's own fields (or the older pre-formatted text).
export function recordRouting(r: RawRecord): Routing | undefined {
  const set = r.setId ? { setId: r.setId } : {};
  if (r.weight !== undefined) return { policy: "weighted", weight: r.weight, ...set };
  if (r.failover) return { policy: "failover", role: /^secondary$/i.test(r.failover) ? "secondary" : "primary", ...set };
  if (r.latencyRegion) return { policy: "latency", ...set };
  if (r.geolocation) return { policy: "geolocation", ...set };
  if (r.geoproximity) return { policy: "geoproximity", ...set };
  if (r.cidr) return { policy: "ip", ...set };
  if (r.multivalue) return { policy: "multivalue", ...set };
  const m = /^(weighted|failover|latency|geolocation|geoproximity|cidr|multivalue)\b\s*(\S*)/.exec(r.routing ?? "");
  if (!m) return undefined;
  const policy = (m[1] === "cidr" ? "ip" : m[1]) as Routing["policy"];
  if (policy === "weighted") return { policy, ...(Number.isFinite(Number(m[2])) && m[2] ? { weight: Number(m[2]) } : {}), ...set };
  if (policy === "failover") return { policy, role: /^secondary$/i.test(m[2]) ? "secondary" : "primary", ...set };
  return { policy, ...set };
}

// "weighted 10", "failover PRIMARY", "latency us-east-1", "geolocation DE", "multivalue" — for evidence and the panel.
export function routingText(r: RawRecord): string | undefined {
  if (r.weight !== undefined) return `weighted ${r.weight}`;
  if (r.failover) return `failover ${r.failover}`;
  if (r.latencyRegion) return `latency ${r.latencyRegion}`;
  if (r.geolocation) return `geolocation ${r.geolocation}`;
  if (r.geoproximity) return `geoproximity ${r.geoproximity}`;
  if (r.cidr) return `ip-based ${r.cidr}`;
  if (r.multivalue) return "multivalue";
  return r.routing;
}

// Records → links from the zone, one per record name (labelled with it: the inventory learns that the name now
// answers on the target, which resolves CNAME chains and origins named by DNS). Alias / CNAME targets and A/AAAA
// addresses become references the inventory resolves (ALB DNS, CloudFront domain, API Gateway custom domain, bucket
// website, Elastic Beanstalk CNAME, App Runner URL, EC2 public IP); NS delegations to another zone in the account link
// zone → zone. A record set with a routing policy carries it on its link (weight, primary/secondary, set id), so a name
// with several answers points at each of them (R15). TXT/MX/SOA/…, and "_…" names (ACM validation, DKIM) are skipped.
export function recordLinks(from: string, zoneName: string, records: RawRecord[], zonesByName: Map<string, string> = new Map()): Link[] {
  const out: Link[] = [];
  for (const r of records) {
    const name = decodeDnsName(r.name);
    if (plumbingName(name)) continue;
    const routing = recordRouting(r);
    const text = routingText(r);
    const label = routing ? `${name} (${routing.policy === "failover" ? `failover ${routing.role}` : routing.policy === "ip" ? "ip-based" : routing.policy})` : name;
    const how = [text, r.setId ? `set ${r.setId}` : "", r.healthCheckId ? `health check ${r.healthCheckId}` : ""].filter(Boolean).join(", ");
    const tail = how ? ` (${how})` : "";
    const withRouting = (l: Link): Link => (routing ? { ...l, routing } : l);
    if ((r.type === "A" || r.type === "AAAA") && r.alias) {
      out.push(withRouting({ from, to: dnsTargetRef(name, r.alias.target), kind: "route", label, evidence: `Route 53 alias ${r.type} ${name} → ${normHost(r.alias.target)}${tail}` }));
    } else if (r.type === "CNAME" && r.values[0]) {
      out.push(withRouting({ from, to: dnsTargetRef(name, r.values[0]), kind: "route", label, evidence: `Route 53 CNAME ${name} → ${normHost(r.values[0])}${tail}` }));
    } else if (r.type === "A" || r.type === "AAAA") {
      for (const v of r.values) if (isIp(v.trim())) out.push(withRouting({ from, to: v.trim(), kind: "route", label, evidence: `Route 53 ${r.type} ${name} → ${v.trim()}${tail}` }));
    } else if (r.type === "NS" && name !== normHost(zoneName)) {
      const child = zonesByName.get(name);
      // No hostname in the label: the inventory would learn it as a name the child zone answers on.
      if (child && child !== from) out.push({ from, to: child, kind: "route", label: "NS delegation", evidence: `NS delegation of ${name}` });
    }
  }
  return mergeLinks(out, 3, true);
}

// ---- Route 53 health checks (CC-20) ----

export interface RawHealthCheck {
  id: string;
  type: string; // HTTP | HTTPS | HTTP_STR_MATCH | HTTPS_STR_MATCH | TCP | CALCULATED | CLOUDWATCH_METRIC | RECOVERY_CONTROL
  fqdn?: string;
  ip?: string;
  port?: number;
  path?: string;
  interval?: number; // seconds between checks (10 or 30)
  failureThreshold?: number;
  checkerRegions?: string[]; // empty = Route 53's default set
  inverted?: boolean;
  disabled?: boolean;
  children?: string[]; // CALCULATED: child health check ids
  healthThreshold?: number; // CALCULATED: children that must be healthy
  alarm?: { name: string; region: string }; // CLOUDWATCH_METRIC
  linkedService?: string; // created and managed by another service (Cloud Map)
  tags?: Record<string, string>; // undefined until read
}

export const healthCheckKey = (id: string) => arnOf.healthCheck(id);
// Only endpoint checks have checkers to ask (GetHealthCheckStatus refuses calculated ones).
export const ENDPOINT_CHECKS = new Set(["HTTP", "HTTPS", "HTTP_STR_MATCH", "HTTPS_STR_MATCH", "TCP"]);
export const isEndpointCheck = (h: Pick<RawHealthCheck, "type">) => ENDPOINT_CHECKS.has(h.type);

const success = (s: string) => /^success\b/i.test(s.trim());

// What the checkers report: all Success → ok; some failing → warning; all failing → error. An inverted check is
// healthy when its endpoint fails. `statuses` undefined = not read (`state` says why).
export function healthCheckHealth(h: Pick<RawHealthCheck, "type" | "disabled" | "inverted">, statuses: string[] | undefined, state?: EnrichState): { health: Health; healthReason?: string } {
  if (h.disabled) return { health: "stopped", healthReason: "health check disabled (Route 53 treats it as healthy)" };
  if (!isEndpointCheck(h)) return { health: "unknown", healthReason: h.type === "CALCULATED" ? "calculated from its child checks — their own status shows here" : `${h.type.toLowerCase().replace(/_/g, " ")} check — status not read here` };
  if (!statuses) {
    const why: Partial<Record<EnrichState, string>> = { capped: "status read for the first checks only", skipped: "status not read (discovery time budget)", denied: "status not readable (route53:GetHealthCheckStatus denied)", error: "status couldn't be read" };
    return { health: "unknown", healthReason: why[state ?? "skipped"] ?? "status not read" };
  }
  if (!statuses.length) return { health: "unknown", healthReason: "no checker has reported yet" };
  const failing = statuses.filter((s) => !success(s));
  const n = statuses.length;
  const first = failing[0]?.replace(/\s+/g, " ").slice(0, 120);
  let health: Health = !failing.length ? "ok" : failing.length === n ? "error" : "warning";
  let healthReason = !failing.length ? undefined : `${failing.length} of ${n} checkers report a failure: ${first}`;
  if (h.inverted) {
    // Inverted: the check is healthy while the endpoint fails.
    health = !failing.length ? "error" : failing.length === n ? "ok" : "warning";
    healthReason = health === "ok" ? undefined : !failing.length ? "inverted check: every checker reaches the endpoint, so it reports unhealthy" : `inverted check: ${n - failing.length} of ${n} checkers reach the endpoint`;
  }
  return { health, healthReason };
}

export const healthCheckTarget = (h: Pick<RawHealthCheck, "type" | "fqdn" | "ip" | "port" | "path">) => {
  if (!isEndpointCheck(h)) return undefined;
  const host = h.fqdn ? normHost(h.fqdn) : h.ip;
  if (!host) return undefined;
  const scheme = h.type.startsWith("HTTPS") ? "https" : h.type.startsWith("HTTP") ? "http" : "tcp";
  const defPort = scheme === "https" ? 443 : scheme === "http" ? 80 : undefined;
  return `${scheme}://${host}${h.port && h.port !== defPort ? `:${h.port}` : ""}${scheme !== "tcp" ? (h.path || "/") : ""}`;
};

// A health check → the hostname or IP it watches (resolved by the inventory, like a DNS target), its child checks, or
// the CloudWatch alarm it follows.
export function healthCheckResource(h: RawHealthCheck, o: { statuses?: string[]; state?: Record<string, EnrichState>; account?: string } = {}): { resource: Resource; links: Link[] } {
  const key = healthCheckKey(h.id);
  const { health, healthReason } = healthCheckHealth(h, o.statuses, o.state?.status);
  const target = healthCheckTarget(h);
  const links: Link[] = [];
  const watched = h.fqdn ? normHost(h.fqdn) : h.ip;
  if (isEndpointCheck(h) && watched) links.push({ from: key, to: watched, kind: "monitors", label: h.type.startsWith("HTTP") ? `${h.type.replace(/_STR_MATCH$/, "")} ${h.path || "/"}` : `TCP ${h.port ?? ""}`.trim(), evidence: `Route 53 health check ${h.id} → ${target}` });
  for (const c of h.children ?? []) links.push({ from: key, to: healthCheckKey(c), kind: "monitors", label: "child check", evidence: `calculated health check ${h.id} (healthy when ${h.healthThreshold ?? "all"} of ${h.children!.length} children are)` });
  if (h.alarm && o.account) links.push({ from: key, to: arnOf.cloudwatchAlarm(h.alarm.region, o.account, h.alarm.name), kind: "monitors", label: "alarm", evidence: `health check ${h.id} follows CloudWatch alarm ${h.alarm.name}` });
  const ok = o.statuses?.filter(success).length;
  const props: Prop[] = [
    { label: "Type", value: h.type.replace(/_/g, " ") },
    ...(target ? [{ label: "Checks", value: target, mono: true }] : []),
    ...(h.interval ? [{ label: "Interval", value: `every ${h.interval} s, unhealthy after ${h.failureThreshold ?? 3} failures` }] : []),
    ...(o.statuses?.length ? [{ label: "Checkers", value: `${ok} of ${o.statuses.length} report success` }] : []),
    ...(h.checkerRegions?.length ? [{ label: "Checker regions", value: h.checkerRegions.join(", ") }] : []),
    ...(h.children?.length ? [{ label: "Child checks", value: `${h.children.length} (healthy when ${h.healthThreshold ?? h.children.length} are)` }] : []),
    ...(h.alarm ? [{ label: "Alarm", value: `${h.alarm.name} (${h.alarm.region})` }] : []),
    ...(h.inverted ? [{ label: "Inverted", value: "yes — healthy while the endpoint fails" }] : []),
    ...(h.disabled ? [{ label: "Disabled", value: "yes" }] : []),
    ...(byCloudMap(h.linkedService) ? [{ label: "Managed by", value: "Cloud Map" }] : []),
    { label: "Health check id", value: h.id, mono: true },
  ];
  return {
    resource: {
      key,
      kind: "health-check",
      provider: "route53",
      name: h.tags?.Name?.trim() || target?.replace(/^\w+:\/\//, "") || `${h.type.toLowerCase()} ${h.id.slice(0, 8)}`,
      region: "global",
      tags: h.tags ?? {},
      ...(h.tags === undefined ? { tagsUnread: true } : {}),
      ...(o.state ? { enrichment: { ...o.state } } : {}),
      health,
      healthReason,
      props,
      aliases: [h.id],
      consoleUrl: `https://console.aws.amazon.com/route53/healthchecks/home#/details/${h.id}`,
    },
    links,
  };
}

// ---- Cloudflare ----

export interface RawCfZone {
  id: string;
  name: string;
  status: string; // active | pending | initializing | moved | deleted | deactivated
  paused?: boolean;
  plan?: string;
  type?: string; // full | partial | secondary
  nameServers: string[];
  accountId?: string;
  accountName?: string;
  createdAt?: number;
  modifiedAt?: number;
}
export interface RawCfRecord {
  id?: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  ttl?: number; // 1 = automatic
}
export interface CloudflareApi {
  zones(cap: number): Promise<{ zones: RawCfZone[]; truncated: boolean }>;
  records(zoneId: string, cap: number, signal?: AbortSignal): Promise<{ records: RawCfRecord[]; truncated: boolean }>;
  purge(zoneId: string, body: PurgeBody): Promise<{ id?: string }>;
}

export const cfZoneKey = (id: string) => `cloudflare:zone/${id}`;

const CF_HEALTH: Record<string, [Resource["health"], string | undefined]> = {
  active: ["ok", undefined],
  pending: ["warning", "waiting for the domain's name servers to point at Cloudflare"],
  initializing: ["unknown", "zone is being set up"],
  moved: ["error", "the domain's name servers moved away from Cloudflare"],
  deactivated: ["stopped", "zone is deactivated"],
  deleted: ["stopped", "zone is deleted"],
};

export function cfZoneResource(z: RawCfZone): Resource {
  let [health, healthReason] = CF_HEALTH[z.status] ?? ["unknown", `status ${z.status}`];
  if (z.paused && health === "ok") [health, healthReason] = ["warning", "paused: Cloudflare answers DNS only (no proxy, cache or WAF)"];
  return {
    key: cfZoneKey(z.id),
    kind: "cloudflare-zone",
    provider: "cloudflare",
    name: z.name,
    region: "global",
    tags: {},
    health,
    healthReason,
    props: [
      { label: "Status", value: z.paused ? `${z.status} (paused)` : z.status },
      ...(z.plan ? [{ label: "Plan", value: z.plan }] : []),
      ...(z.type ? [{ label: "Setup", value: z.type }] : []),
      { label: "Name servers", value: z.nameServers.join(", ") || "none", mono: true },
      { label: "Zone id", value: z.id, mono: true },
      ...(z.accountName ? [{ label: "Account", value: z.accountName }] : []),
    ],
    aliases: [z.id],
    consoleUrl: z.accountId ? `https://dash.cloudflare.com/${z.accountId}/${z.name}/dns` : `https://dash.cloudflare.com/?to=/:account/${z.name}/dns`,
    createdAt: z.createdAt,
    lastModified: z.modifiedAt,
  };
}

// A/AAAA/CNAME records → links from the zone; the proxied flag goes in the label ("shop.acme-shop.com (proxied)").
export function cfRecordLinks(from: string, records: RawCfRecord[]): Link[] {
  const out: Link[] = [];
  for (const r of records) {
    const name = normHost(r.name);
    if (!["A", "AAAA", "CNAME"].includes(r.type) || !r.content || plumbingName(name)) continue;
    const target = r.content.trim();
    out.push({
      from,
      to: dnsTargetRef(name, target),
      kind: "route",
      label: r.proxied ? `${name} (proxied)` : name,
      evidence: `Cloudflare ${r.type} ${name} → ${normHost(target)}, ${r.proxied ? "proxied via Cloudflare" : "DNS only"}`,
    });
  }
  return mergeLinks(out, 3, true);
}

export type PurgeBody = { purge_everything: true } | { files: string[] } | { hosts: string[] };
export interface PurgeInput {
  everything?: boolean;
  urls?: string[];
  hosts?: string[];
}

// Exactly one of: everything, up to 30 URLs, up to 30 hostnames — and every URL/hostname inside the zone.
export function purgeBody(zoneName: string, i: PurgeInput): { body: PurgeBody; summary: string } | { error: string } {
  const urls = i.urls ?? [], hosts = i.hosts ?? [];
  const chosen = [i.everything === true, urls.length > 0, hosts.length > 0].filter(Boolean).length;
  if (chosen !== 1) return { error: "choose exactly one: everything, urls or hosts" };
  if (i.everything) return { body: { purge_everything: true }, summary: `Purge everything cached for ${zoneName}` };
  if (urls.length > 30 || hosts.length > 30) return { error: "at most 30 URLs or hostnames per purge" };
  if (urls.length) {
    for (const raw of urls) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return { error: `not a URL: ${String(raw).slice(0, 80)}` };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return { error: `only http(s) URLs: ${raw.slice(0, 80)}` };
      if (u.username || u.password) return { error: "URLs must not contain credentials" };
      if (!inZone(u.hostname, zoneName)) return { error: `${u.hostname} is not in ${zoneName}` };
    }
    const files = [...new Set(urls)];
    return { body: { files }, summary: `Purge ${files.length} URL${files.length === 1 ? "" : "s"} from ${zoneName}` };
  }
  const list = [...new Set(hosts.map(normHost))];
  for (const h of list) {
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h)) return { error: `not a hostname: ${h.slice(0, 80)}` };
    if (!inZone(h.replace(/^\*\./, ""), zoneName)) return { error: `${h} is not in ${zoneName}` };
  }
  return { body: { hosts: list }, summary: `Purge ${list.length} hostname${list.length === 1 ? "" : "s"} in ${zoneName}` };
}
