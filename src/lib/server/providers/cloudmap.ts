// Cloud Map provider (audit §6 A.2 #3, CC-3, F18): namespaces (with their private hosted zone, from ListNamespaces) and
// services — listed once per namespace, so each has its parent and its <service>.<namespace> DNS name — then, per
// service within the time budget, its instances (ECS tasks link the service to its ECS service, EC2 registrations to
// the instance; none → stopped), their health when the service has a health check, and tags. Read-only. The mapping is
// pure (../../inventory/cloudmap.ts).
import "server-only";
import { GetInstancesHealthStatusCommand, ListInstancesCommand, ListNamespacesCommand, ListServicesCommand, ListTagsForResourceCommand, ServiceDiscoveryClient } from "@aws-sdk/client-servicediscovery";
import { parseArn } from "../../inventory/arn.ts";
import { cloudMapResults, hasHealthCheck, namespaceDetail, serviceDetail, type CloudMapRaw, type Read, type RawCmService, type RawInstance } from "../../inventory/cloudmap.ts";
import type { ResourceDetail } from "../../inventory/types.ts";
import { simCloudMap } from "./mock/cloudmap.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const sd = perRegion((r) => new ServiceDiscoveryClient(sdkConfig(r)), "servicediscovery");
const INSTANCE_READS = 300; // services whose instances are listed (A.0 firstN)
const TAG_READS = 200;

const pages = <T,>(ctx: ProviderContext, what: string, page: (NextToken: string | undefined) => Promise<{ items: T[] | undefined; next?: string }>) =>
  paged<T>(ctx, `cloud map: ${what}`, page, { service: "servicediscovery" });

async function instancesOf(ctx: ProviderContext, region: string, serviceId: string): Promise<RawInstance[]> {
  return pages<RawInstance>(ctx, `instances of ${serviceId}`, async (NextToken) => {
    const r = await sd(region).send(new ListInstancesCommand({ ServiceId: serviceId, MaxResults: 100, NextToken }), t(ctx));
    return { items: r.Instances, next: r.NextToken };
  });
}

async function healthOf(ctx: ProviderContext, region: string, serviceId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const r = await ctx.limit(() => sd(region).send(new GetInstancesHealthStatusCommand({ ServiceId: serviceId, MaxResults: 100, NextToken }), t(ctx)), { service: "servicediscovery" });
    Object.assign(out, r.Status ?? {});
    NextToken = r.NextToken;
  } while (NextToken && !ctx.signal.aborted);
  return out;
}

const reads = <T,>(keys: string[], r: { results: (T | undefined)[]; state: Read<T>["state"][] }): Record<string, Read<T>> =>
  Object.fromEntries(keys.map((k, i) => [k, { ...(r.results[i] !== undefined ? { value: r.results[i] } : {}), state: r.state[i] }]));

export const cloudmapProvider: Provider = {
  id: "cloudmap",
  label: "Cloud Map",
  kinds: ["cloudmap-namespace", "cloudmap-service"],
  scope: "regional",
  covers: ["servicediscovery:service"],
  ttlMs: 5 * 60_000,
  multiRegionMock: true,
  read: [
    "servicediscovery:ListNamespaces", "servicediscovery:ListServices", "servicediscovery:ListInstances", "servicediscovery:GetInstancesHealthStatus",
    "servicediscovery:ListTagsForResource",
  ],
  async discover(ctx) {
    const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
    if (ctx.mock) return cloudMapResults(await simCloudMap(ctx.region), o);
    const c = sd(ctx.region);
    const namespaces = await pages(ctx, "namespaces", async (NextToken) => {
      const r = await c.send(new ListNamespacesCommand({ MaxResults: 100, NextToken }), t(ctx));
      return { items: r.Namespaces, next: r.NextToken };
    });
    // A service summary has no namespace id: ask once per namespace (CC-3).
    const lists = await Promise.all(namespaces.filter((n) => n.Id).map(async (n) => [n.Id!, await pages<RawCmService>(ctx, `services in ${n.Name ?? n.Id}`, async (NextToken) => {
      const r = await c.send(new ListServicesCommand({ Filters: [{ Name: "NAMESPACE_ID", Values: [n.Id!], Condition: "EQ" }], MaxResults: 100, NextToken }), t(ctx));
      return { items: r.Services, next: r.NextToken };
    })] as const));
    const raw: CloudMapRaw = { namespaces, services: Object.fromEntries(lists) };
    ctx.checkpoint?.(cloudMapResults(raw, o));

    const until = budget();
    const services = lists.flatMap(([, l]) => l).filter((s) => s.Id);
    const inst = await enrich(ctx, services, { label: "cloud map: instances", max: INSTANCE_READS, until }, (s) => instancesOf(ctx, ctx.region, s.Id!));
    raw.instances = reads(services.map((s) => s.Id!), inst);
    // Health only where a check is configured and something is registered (InstanceNotFound otherwise).
    const checked = services.filter((s, i) => hasHealthCheck(s) && (inst.results[i]?.length ?? 0) > 0);
    raw.health = reads(checked.map((s) => s.Id!), await enrich(ctx, checked, { label: "cloud map: instance health", max: INSTANCE_READS, until }, (s) => healthOf(ctx, ctx.region, s.Id!)));
    const arns = [...namespaces.map((n) => n.Arn), ...services.map((s) => s.Arn)].filter((a): a is string => !!a);
    raw.tags = reads(arns, await enrich(ctx, arns, { label: "cloud map: tags", max: TAG_READS, until }, async (ResourceARN) => (await c.send(new ListTagsForResourceCommand({ ResourceARN }), t(ctx))).Tags ?? []));
    return cloudMapResults(raw, o);
  },
  // Service: its records, health check and instances (with what registered each). Namespace: its services.
  async detail(r, ctx): Promise<ResourceDetail> {
    const p = parseArn(r.key);
    const region = p?.region || ctx.region;
    const id = p?.id ?? r.aliases?.[0] ?? "";
    if (ctx.mock) {
      const sim = await simCloudMap(region);
      if (r.kind === "cloudmap-namespace") return namespaceDetail(r.key, sim.services[id] ?? [], sim.namespaces.find((n) => n.Id === id) ?? {});
      const s = Object.values(sim.services).flat().find((x) => x.Id === id);
      return serviceDetail(r.key, s, sim.instances?.[id]?.value, sim.health?.[id]?.value);
    }
    const c = sd(region);
    if (r.kind === "cloudmap-namespace") {
      const services = (await ctx.limit(() => c.send(new ListServicesCommand({ Filters: [{ Name: "NAMESPACE_ID", Values: [id], Condition: "EQ" }], MaxResults: 100 }), t(ctx)), { service: "servicediscovery" })).Services ?? [];
      return namespaceDetail(r.key, services, { Name: r.name, Type: r.props.find((x) => x.label === "Type")?.value.startsWith("DNS") ? "DNS_PRIVATE" : "HTTP" });
    }
    const instances = (await ctx.limit(() => c.send(new ListInstancesCommand({ ServiceId: id, MaxResults: 100 }), t(ctx)), { service: "servicediscovery" })).Instances ?? [];
    const checked = !/^none$/.test(r.props.find((x) => x.label === "Health check")?.value ?? "none");
    const status = checked && instances.length ? await healthOf(ctx, region, id).catch(() => undefined) : undefined;
    const d = serviceDetail(r.key, undefined, instances, status);
    const facts = r.props.filter((x) => ["DNS name", "DNS records", "Routing", "Health check"].includes(x.label));
    return { ...d, sections: [...(facts.length ? [{ title: "DNS and health", rows: facts }] : []), ...d.sections] };
  },
};
