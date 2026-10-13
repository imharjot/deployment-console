// Simulated Cloud Map, per region (the provider sets multiRegionMock), in the SDK's shapes so the real mapping runs
// (mock-names CLOUDMAP). us-east-1: production's services register in acme.internal (a private DNS namespace). api and
// worker register their running tasks — taken from the simulated ECS account itself, so scaling a service changes its
// instances; billing's registry has no instances (its ECS service runs without it): stopped. Other regions: nothing.
import type { CloudMapRaw, RawCmService, RawInstance } from "../../../inventory/cloudmap.ts";
import { ACCT, CLOUDMAP, EXISTING, REGION } from "../mock-names.ts";

// The simulated account itself (../../mock.ts), read directly rather than through getCloud(): the same estate, and the
// console's own Cloud reads (what the inventory counts as "security groups read twice") stay untouched. Loaded on use,
// so a real-AWS console never loads the simulation.
const simAccount = async (region: string) => (await import("../../mock.ts")).mockCloud(region);

const NS = CLOUDMAP.namespace;
const CREATED = "2025-03-02T10:20:00.000Z";
const service = (s: { id: string; name: string; arn: string }): RawCmService => ({
  Id: s.id, Arn: s.arn, Name: s.name, Type: "DNS_HTTP", ResourceOwner: ACCT, CreateDate: CREATED,
  DnsConfig: { RoutingPolicy: "MULTIVALUE", DnsRecords: [{ Type: "A", TTL: 10 }] }, HealthCheckCustomConfig: { FailureThreshold: 1 },
});

export async function simCloudMap(region: string): Promise<CloudMapRaw> {
  if (region !== REGION) return { namespaces: [], services: {}, instances: {}, health: {}, tags: {} };
  const cluster = EXISTING.clusters.production;
  const running = await (await simAccount(region)).services(cluster).catch(() => []);
  const registered = (name: string): { list: RawInstance[]; health: Record<string, string> } => {
    const svc = running.find((s) => s.name === name && s.serviceRegistries?.some((r) => r.registryArn === CLOUDMAP.services[name as keyof typeof CLOUDMAP.services]?.arn));
    const tasks = (svc?.tasks ?? []).filter((t) => t.lastStatus === "RUNNING" && t.privateIp);
    return {
      list: tasks.map((t) => ({
        Id: t.id,
        Attributes: {
          AVAILABILITY_ZONE: t.privateIp!.split(".")[2] === "11" ? `${REGION}b` : `${REGION}a`, AWS_INIT_HEALTH_STATUS: "HEALTHY", AWS_INSTANCE_IPV4: t.privateIp!,
          ECS_CLUSTER_NAME: cluster, ECS_SERVICE_NAME: name, ECS_TASK_DEFINITION_FAMILY: `${name}-production`, REGION,
        },
      })),
      health: Object.fromEntries(tasks.map((t) => [t.id, t.health === "UNHEALTHY" ? "UNHEALTHY" : "HEALTHY"])),
    };
  };
  const services = Object.values(CLOUDMAP.services);
  const instances: CloudMapRaw["instances"] = {}, health: CloudMapRaw["health"] = {};
  for (const s of services) {
    const r = registered(s.name);
    instances[s.id] = { value: r.list, state: "ok" };
    if (r.list.length) health[s.id] = { value: r.health, state: "ok" };
  }
  return {
    namespaces: [{
      Id: NS.id, Arn: NS.arn, Name: NS.name, Type: NS.type, ResourceOwner: ACCT, CreateDate: CREATED, ServiceCount: services.length,
      Properties: { DnsProperties: { HostedZoneId: NS.hostedZoneId }, HttpProperties: { HttpName: NS.name } },
    }],
    services: { [NS.id]: services.map(service) },
    instances, health,
    tags: {
      [NS.arn]: { value: [{ Key: "Environment", Value: "production" }], state: "ok" },
      ...Object.fromEntries(services.map((s) => [s.arn, { value: [{ Key: "Environment", Value: "production" }], state: "ok" as const }])),
    },
  };
}
