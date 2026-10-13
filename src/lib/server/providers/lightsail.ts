// Lightsail provider: instances, container services and managed databases (Resource Explorer doesn't index them, so
// it covers nothing). GetInstances, GetContainerServices and GetRelationalDatabases (paged by pageToken; tags come
// with them), then checkpoint — nothing is read per item. Container environment values are kept only as Mention refs;
// the databases' master password (GetRelationalDatabaseMasterUserPassword) is never asked for, and pending password
// changes are dropped here. A region without Lightsail: its endpoint doesn't resolve, which the inventory records as
// "skipped" (not offered there), never as an error. Read-only: no actions, no activity series. The mapper is pure
// (../../inventory/app-platforms.ts).
import "server-only";
import { GetContainerServicesCommand, GetInstancesCommand, GetRelationalDatabasesCommand, LightsailClient } from "@aws-sdk/client-lightsail";
import { lightsailDetail, lightsailResult, type LightsailInput, type RawContainerService, type RawLightsailDatabase, type RawLightsailInstance } from "../../inventory/app-platforms.ts";
import { parseArn } from "../../inventory/arn.ts";
import { classifyError } from "../../inventory/schedule.ts";
import { simLightsail } from "./mock/lightsail.ts";
import { paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const lightsail = perRegion((region) => new LightsailClient(sdkConfig(region)), "lightsail");

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;

// The fields the mapper reads. Instances: no SSH key names or user names; databases: no master user name and no
// pendingModifiedValues (it can carry a new master password).
const instance = (i: RawLightsailInstance): RawLightsailInstance => ({
  name: i.name, arn: i.arn, createdAt: i.createdAt, location: i.location, tags: i.tags, blueprintName: i.blueprintName, bundleId: i.bundleId, isStaticIp: i.isStaticIp,
  privateIpAddress: i.privateIpAddress, publicIpAddress: i.publicIpAddress, ipv6Addresses: i.ipv6Addresses, state: i.state,
  networking: i.networking ? { ports: (i.networking.ports ?? []).map((p) => ({ fromPort: p.fromPort, toPort: p.toPort, protocol: p.protocol, cidrs: p.cidrs, ipv6Cidrs: p.ipv6Cidrs })) } : undefined,
});
const container = (c: RawContainerService): RawContainerService => ({
  containerServiceName: c.containerServiceName, arn: c.arn, createdAt: c.createdAt, location: c.location, tags: c.tags, power: c.power, scale: c.scale, state: c.state,
  stateDetail: c.stateDetail, isDisabled: c.isDisabled, url: c.url, privateDomainName: c.privateDomainName, publicDomainNames: c.publicDomainNames,
  // Commands are dropped; environments are kept for mentions only.
  currentDeployment: c.currentDeployment ? {
    version: c.currentDeployment.version, state: c.currentDeployment.state, publicEndpoint: c.currentDeployment.publicEndpoint,
    containers: Object.fromEntries(Object.entries(c.currentDeployment.containers ?? {}).map(([n, x]) => [n, { image: x.image, environment: x.environment, ports: x.ports }])),
  } : undefined,
});
const database = (d: RawLightsailDatabase): RawLightsailDatabase => ({
  name: d.name, arn: d.arn, createdAt: d.createdAt, location: d.location, tags: d.tags, engine: d.engine, engineVersion: d.engineVersion,
  relationalDatabaseBundleId: d.relationalDatabaseBundleId, state: d.state, backupRetentionEnabled: d.backupRetentionEnabled, publiclyAccessible: d.publiclyAccessible,
  masterEndpoint: d.masterEndpoint ? { address: d.masterEndpoint.address, port: d.masterEndpoint.port } : undefined,
});

const listInstances = (region: string, ctx: ProviderContext) => paged(ctx, "lightsail instances", async (pageToken) => {
  const r = await lightsail(region).send(new GetInstancesCommand({ pageToken }), t(ctx));
  return { items: r.instances?.map((i) => instance(i as RawLightsailInstance)), next: r.nextPageToken };
}, { service: "lightsail" });
// GetContainerServices isn't paged: one call returns every service of the region.
const listContainers = async (region: string, ctx: ProviderContext) =>
  ((await ctx.limit(() => lightsail(region).send(new GetContainerServicesCommand({}), t(ctx)), { service: "lightsail" })).containerServices ?? []).map((c) => container(c as RawContainerService));
const listDatabases = (region: string, ctx: ProviderContext) => paged(ctx, "lightsail databases", async (pageToken) => {
  const r = await lightsail(region).send(new GetRelationalDatabasesCommand({ pageToken }), t(ctx));
  return { items: r.relationalDatabases?.map((d) => database(d as RawLightsailDatabase)), next: r.nextPageToken };
}, { service: "lightsail" });

// Lightsail isn't offered in every region; there the endpoint doesn't resolve. Say so plainly (the inventory turns a
// not-offered error into "skipped" for the region).
function notOffered(e: unknown, region: string): never {
  if (classifyError(e) === "skipped") throw Object.assign(new Error(`Lightsail is not offered in this region (${region}: ${(e as { message?: string })?.message ?? "no endpoint"})`), { name: "UnknownEndpoint", cause: e });
  throw e;
}

async function fetchAll(ctx: ProviderContext): Promise<LightsailInput> {
  // Instances first: in a region without Lightsail this fails fast, before the other two calls are sent.
  const instances = await listInstances(ctx.region, ctx).catch((e: unknown) => notOffered(e, ctx.region));
  const [containers, databases] = await Promise.all([listContainers(ctx.region, ctx), listDatabases(ctx.region, ctx)]);
  const input = { instances, containers, databases };
  ctx.checkpoint?.(lightsailResult(input, { region: ctx.region, account: ctx.accountId }));
  return input;
}

export const lightsailProvider: Provider = {
  id: "lightsail",
  label: "Lightsail",
  kinds: ["lightsail-instance", "lightsail-container", "lightsail-database"],
  scope: "regional",
  covers: [],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["lightsail:GetInstances", "lightsail:GetContainerServices", "lightsail:GetRelationalDatabases"],
  async discover(ctx) {
    return lightsailResult(ctx.mock ? simLightsail(ctx.region) : await fetchAll(ctx), { region: ctx.region, account: ctx.accountId });
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return lightsailDetail(r.key, r.kind, simLightsail(region));
    // The list call of the resource's kind, read again (the singular Get* calls aren't granted).
    const empty: LightsailInput = { instances: [], containers: [], databases: [] };
    if (r.kind === "lightsail-instance") return lightsailDetail(r.key, r.kind, { ...empty, instances: await listInstances(region, ctx) });
    if (r.kind === "lightsail-container") return lightsailDetail(r.key, r.kind, { ...empty, containers: await listContainers(region, ctx) });
    return lightsailDetail(r.key, r.kind, { ...empty, databases: await listDatabases(region, ctx) });
  },
};
