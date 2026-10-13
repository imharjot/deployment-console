// Cloud Map (ECS service discovery) as the cloud map sees it, pure: SDK-shaped ListNamespaces / ListServices /
// ListInstances / GetInstancesHealthStatus / ListTagsForResource answers in; namespace and service resources, their
// links and health out. The provider (../server/providers/cloudmap.ts) and its simulation feed the same functions.
// No AWS calls. (Audit §6 A.2 #3, CC-3, F18.)
//
// - ListNamespaces already carries the private zone (DnsProperties.HostedZoneId): namespace → zone (manages).
// - ListServices is asked once per namespace (its summaries carry no namespace id), so every service has its parent
//   and its DNS name: <service>.<namespace> is the endpoint mentions resolve to.
// - Instances (ListInstances; InstanceCount is null in lists): ECS registers tasks with ECS_CLUSTER_NAME and
//   ECS_SERVICE_NAME → service → that ECS service (route); EC2 registrations (AWS_EC2_INSTANCE_ID) → that instance.
//   0 instances → stopped "no instances registered" (facts.instances = 0; R8 warns when its ECS service wants tasks).
// - Health only from GetInstancesHealthStatus, asked only when the service has a health check and instances (the API
//   answers InstanceNotFound otherwise).
import { arnOf, partitionOf } from "./arn.ts";
import { prop, props } from "./compute-common.ts";
import { enrichmentOf, tagMap } from "./serverless-common.ts";
import { keys, type EnrichState, type Health, type Link, type ProviderResult, type Resource, type ResourceDetail } from "./types.ts";

type When = Date | string | number;
type Tags = { Key?: string; Value?: string }[];
export interface RawNamespace {
  Id?: string;
  Arn?: string;
  Name?: string;
  Type?: string; // DNS_PUBLIC | DNS_PRIVATE | HTTP
  Description?: string;
  ServiceCount?: number;
  Properties?: { DnsProperties?: { HostedZoneId?: string }; HttpProperties?: { HttpName?: string } };
  CreateDate?: When;
  ResourceOwner?: string;
}
export interface RawCmService {
  Id?: string;
  Arn?: string;
  Name?: string;
  Type?: string; // HTTP | DNS_HTTP | DNS
  Description?: string;
  DnsConfig?: { RoutingPolicy?: string; DnsRecords?: { Type?: string; TTL?: number }[] };
  HealthCheckConfig?: { Type?: string; ResourcePath?: string; FailureThreshold?: number };
  HealthCheckCustomConfig?: { FailureThreshold?: number };
  CreateDate?: When;
  ResourceOwner?: string;
}
export interface RawInstance { Id?: string; Attributes?: Record<string, string> }

// One per-item read: its answer (undefined when not read) and how it went.
export interface Read<T> { value?: T; state: EnrichState }
export interface CloudMapRaw {
  namespaces: RawNamespace[];
  services: Record<string, RawCmService[]>; // namespace id → its services
  instances?: Record<string, Read<RawInstance[]>>; // service id → its instances
  health?: Record<string, Read<Record<string, string>>>; // service id → instance id → HEALTHY | UNHEALTHY | UNKNOWN
  tags?: Record<string, Read<Tags>>; // ARN → tags
}
export interface CloudMapOptions { region: string; accountId?: string; home?: string; now?: number }

const ms = (t: When | undefined) => (t === undefined ? undefined : typeof t === "number" ? t : Number.isFinite(new Date(t).getTime()) ? new Date(t).getTime() : undefined);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const dns = (ns: RawNamespace) => ns.Type === "DNS_PRIVATE" || ns.Type === "DNS_PUBLIC";
const TYPE: Record<string, string> = { DNS_PRIVATE: "DNS, private (VPC)", DNS_PUBLIC: "DNS, public", HTTP: "API calls only (no DNS)" };
// AWS's ARN deep link: it opens the resource in whichever console page AWS currently uses for it.
const consoleUrl = (arn: string) => `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(arn)}`;
export const hasHealthCheck = (s: RawCmService) => !!(s.HealthCheckConfig || s.HealthCheckCustomConfig);
export const zoneKey = (zoneId: string, region: string) => `arn:${partitionOf(region)}:route53:::hostedzone/${zoneId}`;
// "<service>.<namespace>" for DNS namespaces.
export const fqdnOf = (s: RawCmService, ns: RawNamespace) => (dns(ns) && s.Type !== "HTTP" && s.Name && ns.Name ? `${s.Name}.${ns.Name}`.toLowerCase() : undefined);

export function healthCheckText(s: RawCmService): string | undefined {
  if (s.HealthCheckCustomConfig) return `custom (reported by ECS or the registrant)${s.HealthCheckCustomConfig.FailureThreshold ? ` — failure threshold ${s.HealthCheckCustomConfig.FailureThreshold}` : ""}`;
  if (s.HealthCheckConfig) return `Route 53 ${s.HealthCheckConfig.Type ?? ""}${s.HealthCheckConfig.ResourcePath ? ` ${s.HealthCheckConfig.ResourcePath}` : ""}`.trim();
  return undefined;
}

export function serviceHealth(instances: RawInstance[] | undefined, status: Record<string, string> | undefined, state: EnrichState | undefined): { health: Health; healthReason?: string } {
  if (!instances) return { health: "unknown", healthReason: `instances not read (${state && state !== "ok" ? state : "skipped"})` };
  if (!instances.length) return { health: "stopped", healthReason: "no instances registered" };
  if (!status) return { health: "ok" };
  const ids = instances.map((i) => i.Id).filter((x): x is string => !!x);
  const bad = ids.filter((id) => status[id] === "UNHEALTHY").length;
  if (!bad) return { health: "ok" };
  if (bad === ids.length) return { health: "error", healthReason: `all ${plural(ids.length, "instance")} unhealthy` };
  return { health: "warning", healthReason: `${bad} of ${plural(ids.length, "instance")} unhealthy` };
}

// "acme-production/api ×2"
const ecsTargets = (instances: RawInstance[]) => {
  const n = new Map<string, number>();
  for (const i of instances) {
    const a = i.Attributes ?? {};
    if (a.ECS_CLUSTER_NAME && a.ECS_SERVICE_NAME) n.set(`${a.ECS_CLUSTER_NAME}/${a.ECS_SERVICE_NAME}`, (n.get(`${a.ECS_CLUSTER_NAME}/${a.ECS_SERVICE_NAME}`) ?? 0) + 1);
  }
  return [...n].map(([k, v]) => `${k} ×${v}`).join(", ");
};

export function cloudMapResults(raw: CloudMapRaw, o: CloudMapOptions): ProviderResult {
  const { region } = o;
  const home = o.home ?? region;
  const acct = o.accountId ?? "";
  const resources: Resource[] = [];
  const links: Link[] = [];
  const stamp = o.now ? { observedAt: o.now } : {};
  const tagsFor = (arn: string): { tags: Record<string, string>; tagsUnread?: true; state?: EnrichState } => {
    const t = raw.tags?.[arn];
    return t?.value ? { tags: tagMap(t.value), state: t.state } : { tags: {}, tagsUnread: true, state: t?.state ?? "skipped" };
  };
  const owner = (x: { ResourceOwner?: string }) => (o.accountId && x.ResourceOwner && x.ResourceOwner !== o.accountId ? { account: x.ResourceOwner } : {});

  for (const ns of raw.namespaces) {
    if (!ns.Id) continue;
    const key = ns.Arn || arnOf.cloudMapNamespace(region, acct, ns.Id);
    const services = (raw.services[ns.Id] ?? []).filter((s) => s.Id);
    const zone = ns.Properties?.DnsProperties?.HostedZoneId;
    const t = tagsFor(key);
    const nsEnrichment = enrichmentOf({ tags: t.state });
    resources.push({
      key, kind: "cloudmap-namespace", provider: "cloudmap", name: ns.Name || ns.Id, region, tags: t.tags, ...(t.tagsUnread ? { tagsUnread: true } : {}), health: "ok",
      props: props(
        prop("Namespace id", ns.Id, true), prop("Type", TYPE[ns.Type ?? ""] ?? ns.Type), prop("Hosted zone", zone, true),
        prop("HTTP name", ns.Properties?.HttpProperties?.HttpName && ns.Properties.HttpProperties.HttpName !== ns.Name ? ns.Properties.HttpProperties.HttpName : undefined),
        prop("Services", Object.hasOwn(raw.services, ns.Id) ? services.length : undefined), prop("Description", ns.Description),
      ),
      aliases: [ns.Id], consoleUrl: consoleUrl(key), ...(ms(ns.CreateDate) ? { createdAt: ms(ns.CreateDate) } : {}),
      ...(nsEnrichment ? { enrichment: nsEnrichment } : {}), ...owner(ns), ...stamp,
    });
    if (zone) links.push({ from: key, to: zoneKey(zone, region), kind: "manages", label: "DNS records", evidence: `Cloud Map namespace ${ns.Name ?? ns.Id} (HostedZoneId)` });

    for (const s of services) {
      const skey = s.Arn || arnOf.cloudMapService(region, acct, s.Id!);
      const fqdn = fqdnOf(s, ns);
      const inst = raw.instances?.[s.Id!];
      const hs = raw.health?.[s.Id!];
      const list = inst?.value;
      const st = tagsFor(skey);
      const records = (s.DnsConfig?.DnsRecords ?? []).map((r) => `${r.Type ?? "?"}${r.TTL !== undefined ? ` (TTL ${r.TTL} s)` : ""}`).join(", ");
      const enrichment = enrichmentOf({ instances: inst?.state ?? "skipped", health: hasHealthCheck(s) && list?.length ? hs?.state ?? "skipped" : undefined, tags: st.state });
      resources.push({
        key: skey, kind: "cloudmap-service", provider: "cloudmap", name: fqdn ?? `${s.Name ?? s.Id} (${ns.Name ?? ns.Id})`, region, tags: st.tags, ...(st.tagsUnread ? { tagsUnread: true } : {}),
        ...serviceHealth(list, hs?.value, inst?.state),
        props: props(
          prop("Service id", s.Id, true), prop("Namespace", ns.Name), prop("DNS name", fqdn, true), prop("DNS records", records), prop("Routing", s.DnsConfig?.RoutingPolicy?.toLowerCase()),
          prop("Health check", healthCheckText(s) ?? "none"), prop("Instances", list ? `${list.length}${ecsTargets(list) ? ` — ${ecsTargets(list)}` : ""}` : undefined),
          prop("Description", s.Description),
        ),
        aliases: [s.Id!], parent: key, ...(fqdn ? { endpoints: [fqdn] } : {}),
        ...(list ? { facts: { instances: list.length } } : {}),
        consoleUrl: consoleUrl(skey), ...(ms(s.CreateDate) ? { createdAt: ms(s.CreateDate) } : {}),
        ...(enrichment ? { enrichment } : {}),
        ...owner(s), ...stamp,
      });
      // What the instances are: ECS tasks of a service, EC2 instances.
      const ecs = new Set<string>(), ec2 = new Set<string>();
      for (const i of list ?? []) {
        const a = i.Attributes ?? {};
        if (a.ECS_CLUSTER_NAME && a.ECS_SERVICE_NAME) ecs.add(`${a.ECS_CLUSTER_NAME}\n${a.ECS_SERVICE_NAME}`);
        if (a.AWS_EC2_INSTANCE_ID) ec2.add(a.AWS_EC2_INSTANCE_ID);
      }
      for (const x of ecs) {
        const [cluster, service] = x.split("\n");
        links.push({ from: skey, to: keys.ecsService(cluster, service, region, home), kind: "route", label: `${fqdn ?? s.Name ?? ""} → tasks`.trim(), evidence: "Cloud Map instances registered by ECS (ECS_CLUSTER_NAME / ECS_SERVICE_NAME)" });
      }
      for (const id of ec2) links.push({ from: skey, to: keys.ec2(id, region, home), kind: "route", label: fqdn ?? s.Name ?? "", evidence: "Cloud Map instance attribute AWS_EC2_INSTANCE_ID" });
    }
  }
  return { resources, links, mentions: [] };
}

// ---------- detail ----------

// A service's instances: id, address, zone, what registered it, health.
export function instanceRows(instances: RawInstance[], status?: Record<string, string>): string[][] {
  return instances.map((i) => {
    const a = i.Attributes ?? {};
    const addr = a.AWS_INSTANCE_IPV4 ?? a.AWS_INSTANCE_IPV6 ?? a.AWS_INSTANCE_CNAME ?? a.AWS_ALIAS_DNS_NAME ?? "";
    const owner = a.ECS_CLUSTER_NAME && a.ECS_SERVICE_NAME ? `ECS ${a.ECS_CLUSTER_NAME}/${a.ECS_SERVICE_NAME}` : a.AWS_EC2_INSTANCE_ID ? `EC2 ${a.AWS_EC2_INSTANCE_ID}` : "";
    return [i.Id ?? "", `${addr}${a.AWS_INSTANCE_PORT ? `:${a.AWS_INSTANCE_PORT}` : ""}`, a.AVAILABILITY_ZONE ?? "", owner, status?.[i.Id ?? ""] ?? (status ? "UNKNOWN" : "—")];
  });
}

export function serviceDetail(key: string, s: RawCmService | undefined, instances: RawInstance[] | undefined, status: Record<string, string> | undefined): ResourceDetail {
  return {
    key,
    sections: [
      ...(s
        ? [{
          title: "DNS and health", rows: props(
            prop("Records", (s.DnsConfig?.DnsRecords ?? []).map((r) => `${r.Type ?? "?"} (TTL ${r.TTL ?? "?"} s)`).join(", ") || "none (API calls only)"),
            prop("Routing", s.DnsConfig?.RoutingPolicy?.toLowerCase()), prop("Health check", healthCheckText(s) ?? "none"),
          ),
        }]
        : []),
      ...(instances
        ? [{ title: "Instances", table: { columns: ["Instance", "Address", "Zone", "Registered by", "Health"], rows: instanceRows(instances, status) }, ...(instances.length ? {} : { note: "No instances registered: lookups of this name find nothing." }) }]
        : []),
    ],
  };
}

export function namespaceDetail(key: string, services: RawCmService[], ns: Pick<RawNamespace, "Name" | "Type">): ResourceDetail {
  return {
    key,
    sections: [{
      title: "Services", table: {
        columns: ["Service", "DNS name", "Records", "Health check"],
        rows: services.map((s) => [s.Name ?? s.Id ?? "", fqdnOf(s, ns) ?? "—", (s.DnsConfig?.DnsRecords ?? []).map((r) => r.Type).filter(Boolean).join(", "), healthCheckText(s) ?? "none"]),
      },
    }],
  };
}
