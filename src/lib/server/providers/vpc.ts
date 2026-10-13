// VPC networking provider (audit §6 A.2 #1): VPCs, subnets (classified by their effective route table), NAT and
// internet gateways, VPC endpoints, peerings, transit gateway attachments, unattached Elastic IPs and VPN connections,
// with the subnet facts the exposure rule reads (routesToIgw, naclOpen) and warnings for "private" subnets that route
// to the internet and for subnets running out of addresses. Route tables and network ACLs aren't nodes (subnet props
// and facts; their ids fold into the VPC). Two phases: the topology (VPCs, subnets, route tables, ACLs, internet
// gateways) is checkpointed (R18), then the gateways, endpoints, peerings, addresses, flow logs and VPNs follow.
// No network interfaces are read here. Read-only. The mapping is pure (../../inventory/vpc.ts).
import "server-only";
import {
  DescribeAddressesCommand, DescribeEgressOnlyInternetGatewaysCommand, DescribeFlowLogsCommand, DescribeInternetGatewaysCommand, DescribeNatGatewaysCommand,
  DescribeNetworkAclsCommand, DescribeRouteTablesCommand, DescribeSubnetsCommand, DescribeTransitGatewayAttachmentsCommand, DescribeVpcEndpointsCommand,
  DescribeVpcPeeringConnectionsCommand, DescribeVpcsCommand, DescribeVpnConnectionsCommand, EC2Client,
} from "@aws-sdk/client-ec2";
import { parseArn } from "../../inventory/arn.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { subnetDetail, vpcDetail, vpcResults, vpnHealth, vpnView, type RawVpn, type VpcRaw } from "../../inventory/vpc.ts";
import { simNetwork } from "./mock/vpc.ts";
import { paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const ec2 = perRegion((r) => new EC2Client(sdkConfig(r)), "ec2");

type Filters = { Name: string; Values: string[] }[] | undefined;

// The list calls, one region (optionally one VPC: the panel). Page sizes: route tables at most 100 and egress-only
// gateways at most 255 per page (CC-2); addresses and VPN connections are unpaginated.
function reads(ctx: ProviderContext, region: string, vpcId?: string) {
  const c = ec2(region);
  const by = (name: string): Filters => (vpcId ? [{ Name: name, Values: [vpcId] }] : undefined);
  const all = <T,>(label: string, page: (NextToken: string | undefined) => Promise<{ items: T[] | undefined; next?: string }>) => paged<T>(ctx, `vpc: ${label}`, page, { service: "ec2" });
  return {
    vpcs: () => all("VPCs", async (NextToken) => {
      const r = await c.send(new DescribeVpcsCommand({ Filters: by("vpc-id"), MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.Vpcs, next: r.NextToken };
    }),
    subnets: () => all("subnets", async (NextToken) => {
      const r = await c.send(new DescribeSubnetsCommand({ Filters: by("vpc-id"), MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.Subnets, next: r.NextToken };
    }),
    routeTables: () => all("route tables", async (NextToken) => {
      const r = await c.send(new DescribeRouteTablesCommand({ Filters: by("vpc-id"), MaxResults: 100, NextToken }), t(ctx));
      return { items: r.RouteTables, next: r.NextToken };
    }),
    nacls: () => all("network ACLs", async (NextToken) => {
      const r = await c.send(new DescribeNetworkAclsCommand({ Filters: by("vpc-id"), MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.NetworkAcls, next: r.NextToken };
    }),
    internetGateways: () => all("internet gateways", async (NextToken) => {
      const r = await c.send(new DescribeInternetGatewaysCommand({ Filters: by("attachment.vpc-id"), MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.InternetGateways, next: r.NextToken };
    }),
    natGateways: () => all("NAT gateways", async (NextToken) => {
      const r = await c.send(new DescribeNatGatewaysCommand({ Filter: by("vpc-id"), MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.NatGateways, next: r.NextToken };
    }),
    egressOnly: () => all("egress-only internet gateways", async (NextToken) => {
      const r = await c.send(new DescribeEgressOnlyInternetGatewaysCommand({ MaxResults: 255, NextToken }), t(ctx));
      return { items: r.EgressOnlyInternetGateways, next: r.NextToken };
    }),
    endpoints: () => all("VPC endpoints", async (NextToken) => {
      const r = await c.send(new DescribeVpcEndpointsCommand({ Filters: by("vpc-id"), MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.VpcEndpoints, next: r.NextToken };
    }),
    peerings: () => all("peering connections", async (NextToken) => {
      const r = await c.send(new DescribeVpcPeeringConnectionsCommand({ MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.VpcPeeringConnections, next: r.NextToken };
    }),
    tgwAttachments: () => all("transit gateway attachments", async (NextToken) => {
      const r = await c.send(new DescribeTransitGatewayAttachmentsCommand({ Filters: by("resource-id"), MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.TransitGatewayAttachments, next: r.NextToken };
    }),
    addresses: () => ctx.limit(async () => (await c.send(new DescribeAddressesCommand({}), t(ctx))).Addresses ?? [], { service: "ec2" }),
    flowLogs: () => all("flow logs", async (NextToken) => {
      const r = await c.send(new DescribeFlowLogsCommand({ MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.FlowLogs, next: r.NextToken };
    }),
    // The answer also carries the tunnels' pre-shared keys: only vpnView's fields leave this call.
    vpns: () => ctx.limit(async () => ((await c.send(new DescribeVpnConnectionsCommand({}), t(ctx))).VpnConnections ?? []).map((v) => vpnView(v as RawVpn)), { service: "ec2" }),
  };
}

// An optional list: undefined (noted once) when it is denied or fails, so the facts it decides stay unknown.
const optional = <T,>(ctx: ProviderContext, label: string, fn: () => Promise<T>) => softly(ctx, `vpc: ${label}`, { limited: false, service: "ec2" })(fn);

async function readRegion(ctx: ProviderContext, region: string, checkpoint: (raw: VpcRaw) => void): Promise<VpcRaw> {
  const r = reads(ctx, region);
  // Phase 1, the topology: VPCs, subnets and route tables are required; ACLs and internet gateways optional.
  const [vpcs, subnets, routeTables, nacls, internetGateways] = await Promise.all([
    r.vpcs(), r.subnets(), r.routeTables(), optional(ctx, "network ACLs", r.nacls), optional(ctx, "internet gateways", r.internetGateways),
  ]);
  const topology: VpcRaw = { vpcs, subnets, routeTables, nacls, internetGateways };
  checkpoint(topology);
  const [natGateways, egressOnly, endpoints, peerings, tgwAttachments, addresses, flowLogs, vpns] = await Promise.all([
    optional(ctx, "NAT gateways", r.natGateways), optional(ctx, "egress-only internet gateways", r.egressOnly), optional(ctx, "VPC endpoints", r.endpoints),
    optional(ctx, "peering connections", r.peerings), optional(ctx, "transit gateway attachments", r.tgwAttachments), optional(ctx, "Elastic IPs", r.addresses),
    optional(ctx, "flow logs", r.flowLogs), optional(ctx, "VPN connections", r.vpns),
  ]);
  return { ...topology, natGateways, egressOnly, endpoints, peerings, tgwAttachments, addresses, flowLogs, vpns };
}

const idOf = (r: Resource) => parseArn(r.key)?.id ?? r.aliases?.[0] ?? r.key;
const regionOf = (r: Resource, ctx: { region: string }) => parseArn(r.key)?.region || ctx.region;

// The map's resources in a subnet (best effort: the built map, never a wait for a rebuild).
async function inSubnet(id: string): Promise<Resource[]> {
  try {
    const { getInventory } = await import("../inventory.ts");
    const view = await Promise.race([getInventory(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 1_500).unref?.())]);
    return (view?.resources ?? []).filter((x) => x.subnetIds?.includes(id) && x.kind !== "subnet");
  } catch {
    return [];
  }
}

export const vpcProvider: Provider = {
  id: "vpc",
  label: "VPC networking",
  kinds: [
    "vpc", "subnet", "nat-gateway", "internet-gateway", "vpc-endpoint", "vpc-peering", "transit-gateway-attachment", "elastic-ip",
    "vpn-connection",
  ],
  scope: "regional",
  covers: [
    "ec2:vpc", "ec2:subnet", "ec2:natgateway", "ec2:internet-gateway", "ec2:egress-only-internet-gateway", "ec2:vpc-endpoint",
    "ec2:vpc-peering-connection", "ec2:transit-gateway-attachment", "ec2:elastic-ip", "ec2:route-table", "ec2:network-acl",
    "ec2:vpn-connection",
  ],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: [
    "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeRouteTables", "ec2:DescribeNatGateways", "ec2:DescribeInternetGateways",
    "ec2:DescribeEgressOnlyInternetGateways", "ec2:DescribeVpcEndpoints", "ec2:DescribeVpcPeeringConnections", "ec2:DescribeTransitGatewayAttachments",
    "ec2:DescribeAddresses", "ec2:DescribeFlowLogs", "ec2:DescribeNetworkAcls", "ec2:DescribeVpnConnections",
  ],
  async discover(ctx) {
    const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
    if (ctx.mock) {
      const out = vpcResults(simNetwork(ctx.region), o);
      // The simulation's NAT gateway carries traffic all day (its activity, since simulated metrics aren't read).
      for (const r of out.resources) if (r.kind === "nat-gateway") r.lastActivityAt = o.now - 60_000;
      return out;
    }
    const raw = await readRegion(ctx, ctx.region, (topology) => ctx.checkpoint?.(vpcResults(topology, o)));
    return vpcResults(raw, o);
  },
  // NAT gateways only: bytes sent out to the internet (or the routed destination).
  activity: (r) =>
    r.kind === "nat-gateway"
      ? [{ namespace: "AWS/NATGateway", metric: "BytesOutToDestination", dims: { NatGatewayId: idOf(r) }, stat: "Sum", label: "bytes sent out", region: parseArn(r.key)?.region || undefined, required: true }]
      : [],
  // VPC: its subnets, route tables, ACLs, gateways, peerings and flow logs. Subnet: its routes, its ACL's inbound rules
  // and what the map has in it. VPN: its tunnels. The rest show their props.
  async detail(r, ctx): Promise<ResourceDetail> {
    const region = regionOf(r, ctx);
    const id = idOf(r);
    if (r.kind === "vpn-connection") {
      // A deleted connection answers InvalidVpnConnectionID.NotFound: the panel says so instead of failing.
      const live = async () => {
        try {
          const found = (await ctx.limit(() => ec2(region).send(new DescribeVpnConnectionsCommand({ VpnConnectionIds: [id] }), t(ctx)), { service: "ec2" })).VpnConnections?.[0];
          return found && !["deleted", "deleting"].includes(String(found.State ?? "").toLowerCase()) ? vpnView(found as RawVpn) : undefined;
        } catch (e) {
          if (/NotFound/.test((e as { name?: string })?.name ?? "")) return undefined;
          throw e;
        }
      };
      const v = ctx.mock ? simNetwork(region).vpns?.find((x) => x.VpnConnectionId === id) : await live();
      const tunnels = v?.VgwTelemetry ?? [];
      return {
        key: r.key,
        sections: [{
          title: "Tunnels", table: { columns: ["Outside IP", "Status", "Since", "Message"], rows: tunnels.map((x) => [x.OutsideIpAddress ?? "", x.Status ?? "", x.LastStatusChange ? new Date(x.LastStatusChange).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "", x.StatusMessage ?? ""]) },
          ...(v ? { note: vpnHealth(v).healthReason } : { note: "VPN connection not found — it may have been deleted." }),
        }],
      };
    }
    if (r.kind !== "vpc" && r.kind !== "subnet") return { key: r.key, sections: [] };
    const vpcId = r.kind === "vpc" ? id : r.vpcId;
    let raw: VpcRaw;
    if (ctx.mock) raw = simNetwork(region);
    else {
      if (!vpcId) return { key: r.key, sections: [{ title: "Details", note: "The subnet's VPC isn't known." }] };
      const q = reads(ctx, region, vpcId);
      const [subnets, routeTables, nacls] = await Promise.all([q.subnets(), q.routeTables(), optional(ctx, "network ACLs", q.nacls)]);
      raw = { vpcs: [], subnets, routeTables, nacls };
      if (r.kind === "vpc") {
        const [internetGateways, natGateways, egressOnly, endpoints, peerings, tgwAttachments, flowLogs, vpns] = await Promise.all([
          optional(ctx, "internet gateways", q.internetGateways), optional(ctx, "NAT gateways", q.natGateways), optional(ctx, "egress-only internet gateways", q.egressOnly),
          optional(ctx, "VPC endpoints", q.endpoints), optional(ctx, "peering connections", q.peerings), optional(ctx, "transit gateway attachments", q.tgwAttachments),
          optional(ctx, "flow logs", q.flowLogs), optional(ctx, "VPN connections", q.vpns),
        ]);
        raw = { ...raw, internetGateways, natGateways, egressOnly, endpoints, peerings, tgwAttachments, flowLogs, vpns };
      }
    }
    if (r.kind === "vpc") return vpcDetail(r.key, id, raw);
    const d = subnetDetail(r.key, id, raw);
    const here = await inSubnet(id);
    if (here.length) d.sections.push({ title: "On the map in this subnet", table: { columns: ["Name", "Kind", "Environment"], rows: here.map((x) => [x.name, x.kind, x.env ?? "—"]) } });
    return d;
  },
};
