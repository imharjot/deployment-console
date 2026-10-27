// VPC networking as the cloud map sees it, pure: SDK-shaped Describe* answers in (VPCs, subnets, route tables, NAT and
// internet gateways, endpoints, peerings, transit gateway attachments, Elastic IPs, flow logs, network ACLs, VPN
// connections); map resources, links and the subnet facts the exposure rule reads out. The provider
// (../server/providers/vpc.ts) and its simulation feed the same functions. No AWS calls. (Audit §6 A.2 #1.)
//
// - A subnet's class comes from its effective route table — its explicit association, else the VPC's main table:
//   a default route (0.0.0.0/0 or ::/0) to igw- → public; 0.0.0.0/0 to nat- → private (NAT); to tgw-, vgw-, eni-, i-,
//   pcx- or a Gateway Load Balancer vpce- → private (routed); ::/0 to eigw- → IPv6 egress-only; none → isolated.
// - Facts on subnets (R4): routesToIgw, and naclOpen — the inbound ports its network ACL lets in from 0.0.0.0/0 (or
//   ::/0), evaluated in rule-number order ("all" when everything is). VPCs carry their CIDRs as facts.cidrs, and
//   facts.isDefault when AWS created them (one per region; the untouched ones are hidden, R10).
// - States are compared lower-cased (the API says "available" where the model says "Available", CC-4).
// - An Elastic IP is a node only when it is associated with nothing and no AWS service manages it ("not attached —
//   billed hourly"); one a NAT gateway uses is an alias of that gateway; the rest are hidden table rows.
// - Route tables and network ACLs are never nodes: their ids and ARNs are aliases of their VPC, they become subnet
//   props and facts. No network interfaces are read here, and no facts are set on resources other providers own.
// - VPN connections: DescribeVpnConnections also returns the tunnels' pre-shared keys (CustomerGatewayConfiguration,
//   TunnelOptions); only ids, state, type, tags and VgwTelemetry are read from it.
import { arnBase, arnOf, partitionOf } from "./arn.ts";
import { prop, props, uniq } from "./compute-common.ts";
import { normProtocol } from "./security-group.ts";
import { tagMap } from "./serverless-common.ts";
import { keys, type Health, type Link, type Prop, type ProviderResult, type Resource, type ResourceDetail } from "./types.ts";

// ---------- raw shapes (the SDK's field names) ----------

type Tags = { Key?: string; Value?: string }[];
type When = Date | string | number;
export interface RawVpc {
  VpcId?: string;
  OwnerId?: string;
  CidrBlock?: string;
  CidrBlockAssociationSet?: { CidrBlock?: string; CidrBlockState?: { State?: string } }[];
  Ipv6CidrBlockAssociationSet?: { Ipv6CidrBlock?: string; Ipv6CidrBlockState?: { State?: string } }[];
  State?: string;
  IsDefault?: boolean;
  DhcpOptionsId?: string;
  InstanceTenancy?: string;
  Tags?: Tags;
}
export interface RawSubnet {
  SubnetId?: string;
  VpcId?: string;
  OwnerId?: string;
  CidrBlock?: string;
  Ipv6CidrBlockAssociationSet?: { Ipv6CidrBlock?: string }[];
  AvailabilityZone?: string;
  AvailableIpAddressCount?: number;
  MapPublicIpOnLaunch?: boolean;
  DefaultForAz?: boolean;
  State?: string;
  Tags?: Tags;
}
export interface RawRoute {
  DestinationCidrBlock?: string;
  DestinationIpv6CidrBlock?: string;
  DestinationPrefixListId?: string;
  GatewayId?: string;
  NatGatewayId?: string;
  TransitGatewayId?: string;
  VpcPeeringConnectionId?: string;
  NetworkInterfaceId?: string;
  InstanceId?: string;
  EgressOnlyInternetGatewayId?: string;
  LocalGatewayId?: string;
  CarrierGatewayId?: string;
  CoreNetworkArn?: string;
  State?: string;
}
export interface RawRouteTable {
  RouteTableId?: string;
  VpcId?: string;
  OwnerId?: string;
  Associations?: { SubnetId?: string; Main?: boolean; GatewayId?: string }[];
  Routes?: RawRoute[];
  PropagatingVgws?: { GatewayId?: string }[];
  Tags?: Tags;
}
export interface RawNat {
  NatGatewayId?: string;
  SubnetId?: string;
  VpcId?: string;
  State?: string;
  ConnectivityType?: string;
  NatGatewayAddresses?: { AllocationId?: string; PublicIp?: string; PrivateIp?: string; NetworkInterfaceId?: string }[];
  FailureMessage?: string;
  CreateTime?: When;
  Tags?: Tags;
}
export interface RawIgw { InternetGatewayId?: string; OwnerId?: string; Attachments?: { State?: string; VpcId?: string }[]; Tags?: Tags }
export interface RawEigw { EgressOnlyInternetGatewayId?: string; OwnerId?: string; Attachments?: { State?: string; VpcId?: string }[]; Tags?: Tags }
export interface RawEndpoint {
  VpcEndpointId?: string;
  VpcEndpointType?: string;
  VpcId?: string;
  ServiceName?: string;
  State?: string;
  RouteTableIds?: string[];
  SubnetIds?: string[];
  Groups?: { GroupId?: string }[];
  PrivateDnsEnabled?: boolean;
  DnsEntries?: { DnsName?: string }[];
  OwnerId?: string;
  CreationTimestamp?: When;
  LastError?: { Message?: string };
  Tags?: Tags;
}
export interface RawPeerVpc { VpcId?: string; OwnerId?: string; Region?: string; CidrBlock?: string; CidrBlockSet?: { CidrBlock?: string }[] }
export interface RawPeering { VpcPeeringConnectionId?: string; Status?: { Code?: string; Message?: string }; RequesterVpcInfo?: RawPeerVpc; AccepterVpcInfo?: RawPeerVpc; Tags?: Tags }
export interface RawTgwAttachment {
  TransitGatewayAttachmentId?: string;
  TransitGatewayId?: string;
  TransitGatewayOwnerId?: string;
  ResourceOwnerId?: string;
  ResourceType?: string;
  ResourceId?: string;
  State?: string;
  CreationTime?: When;
  Tags?: Tags;
}
export interface RawAddress {
  AllocationId?: string;
  AssociationId?: string;
  PublicIp?: string;
  PrivateIpAddress?: string;
  InstanceId?: string;
  NetworkInterfaceId?: string;
  Domain?: string;
  ServiceManaged?: string;
  Tags?: Tags;
}
export interface RawFlowLog { FlowLogId?: string; ResourceId?: string; LogDestinationType?: string; LogGroupName?: string; LogDestination?: string; TrafficType?: string; FlowLogStatus?: string; DeliverLogsStatus?: string }
export interface RawNaclEntry { RuleNumber?: number; Egress?: boolean; Protocol?: string; RuleAction?: string; CidrBlock?: string; Ipv6CidrBlock?: string; PortRange?: { From?: number; To?: number } }
export interface RawNacl { NetworkAclId?: string; VpcId?: string; OwnerId?: string; IsDefault?: boolean; Entries?: RawNaclEntry[]; Associations?: { SubnetId?: string }[]; Tags?: Tags }
export interface RawVpn {
  VpnConnectionId?: string;
  State?: string;
  Type?: string;
  Category?: string;
  CustomerGatewayId?: string;
  VpnGatewayId?: string;
  TransitGatewayId?: string;
  VgwTelemetry?: { OutsideIpAddress?: string; Status?: string; StatusMessage?: string; LastStatusChange?: When }[];
  Tags?: Tags;
}

// What one region's read gave. A list that wasn't read (denied, failed) is undefined: the facts it would decide stay
// unknown — a subnet without route tables has no routesToIgw, which the exposure rule counts as routed.
export interface VpcRaw {
  vpcs: RawVpc[];
  subnets?: RawSubnet[];
  routeTables?: RawRouteTable[];
  natGateways?: RawNat[];
  internetGateways?: RawIgw[];
  egressOnly?: RawEigw[];
  endpoints?: RawEndpoint[];
  peerings?: RawPeering[];
  tgwAttachments?: RawTgwAttachment[];
  addresses?: RawAddress[];
  flowLogs?: RawFlowLog[];
  nacls?: RawNacl[];
  vpns?: RawVpn[];
}

// Only the fields the map uses: everything else a VPN connection carries (its tunnels' pre-shared keys among them) is
// dropped right where the API answer arrives.
export const vpnView = (v: RawVpn): RawVpn => ({
  VpnConnectionId: v.VpnConnectionId, State: v.State, Type: v.Type, Category: v.Category, CustomerGatewayId: v.CustomerGatewayId, VpnGatewayId: v.VpnGatewayId,
  TransitGatewayId: v.TransitGatewayId, Tags: v.Tags,
  VgwTelemetry: (v.VgwTelemetry ?? []).map((x) => ({ OutsideIpAddress: x.OutsideIpAddress, Status: x.Status, StatusMessage: x.StatusMessage, LastStatusChange: x.LastStatusChange })),
});

// ---------- small helpers ----------

const lower = (s: string | undefined) => String(s ?? "").toLowerCase();
const ms = (t: When | undefined) => (t === undefined ? undefined : typeof t === "number" ? t : Number.isFinite(new Date(t).getTime()) ? new Date(t).getTime() : undefined);
const nameOf = (tags: Record<string, string>, id: string) => tags.Name?.trim() || id;
const n = (x: number) => x.toLocaleString("en-US");
const consoleUrl = (region: string, hash: string) => `https://${region}.console.aws.amazon.com/vpcconsole/home?region=${region}#${hash}`;

// ---------- routes and classes ----------

export type SubnetClass = "public" | "private-nat" | "private-routed" | "ipv6-egress-only" | "isolated";
export const CLASS_LABEL: Record<SubnetClass, string> = {
  public: "Public", "private-nat": "Private (NAT)", "private-routed": "Private (routed)", "ipv6-egress-only": "IPv6 egress-only", isolated: "Isolated",
};

// Where a route sends traffic: the id of its target ("local" for the VPC's own range).
export const routeTarget = (r: RawRoute): string | undefined =>
  r.GatewayId ?? r.NatGatewayId ?? r.TransitGatewayId ?? r.VpcPeeringConnectionId ?? r.InstanceId ?? r.NetworkInterfaceId ?? r.EgressOnlyInternetGatewayId ??
  r.LocalGatewayId ?? r.CarrierGatewayId ?? r.CoreNetworkArn;
const destination = (r: RawRoute) => r.DestinationCidrBlock ?? r.DestinationIpv6CidrBlock ?? r.DestinationPrefixListId ?? "?";
const active = (r: RawRoute) => lower(r.State) !== "blackhole";

export interface Classified { class: SubnetClass; target?: string; route?: "0.0.0.0/0" | "::/0"; routesToIgw: boolean; label: string }
export function classify(routes: RawRoute[]): Classified {
  const live = routes.filter(active);
  const v4 = routeTarget(live.find((r) => r.DestinationCidrBlock === "0.0.0.0/0") ?? {});
  const v6 = routeTarget(live.find((r) => r.DestinationIpv6CidrBlock === "::/0") ?? {});
  if (v4?.startsWith("igw-")) return { class: "public", target: v4, route: "0.0.0.0/0", routesToIgw: true, label: `Public — 0.0.0.0/0 → ${v4}` };
  if (v6?.startsWith("igw-")) return { class: "public", target: v6, route: "::/0", routesToIgw: true, label: `Public — ::/0 → ${v6}` };
  if (v4?.startsWith("nat-")) return { class: "private-nat", target: v4, route: "0.0.0.0/0", routesToIgw: false, label: `Private (NAT ${v4})` };
  if (v4) return { class: "private-routed", target: v4, route: "0.0.0.0/0", routesToIgw: false, label: `Private (routed via ${v4})` };
  if (v6?.startsWith("eigw-")) return { class: "ipv6-egress-only", target: v6, route: "::/0", routesToIgw: false, label: `IPv6 egress-only (${v6})` };
  if (v6) return { class: "private-routed", target: v6, route: "::/0", routesToIgw: false, label: `Private (routed via ${v6})` };
  return { class: "isolated", routesToIgw: false, label: "Isolated (no default route)" };
}

// A subnet's effective route table: its explicit association, else its VPC's main table.
export function effectiveTable(subnet: Pick<RawSubnet, "SubnetId" | "VpcId">, tables: RawRouteTable[]): { table?: RawRouteTable; main: boolean } {
  const explicit = tables.find((t) => t.Associations?.some((a) => a.SubnetId === subnet.SubnetId));
  if (explicit) return { table: explicit, main: false };
  return { table: tables.find((t) => t.VpcId === subnet.VpcId && t.Associations?.some((a) => a.Main)), main: true };
}

// ---------- network ACLs ----------

type Range = [number, number];
function subtract(ranges: Range[], [a, b]: Range): Range[] {
  const out: Range[] = [];
  for (const [x, y] of ranges) {
    if (b < x || a > y) out.push([x, y]);
    else {
      if (x < a) out.push([x, a - 1]);
      if (y > b) out.push([b + 1, y]);
    }
  }
  return out;
}
const intersect = (ranges: Range[], [a, b]: Range): Range[] => ranges.flatMap(([x, y]) => (Math.max(x, a) <= Math.min(y, b) ? [[Math.max(x, a), Math.min(y, b)] as Range] : []));
function merge(ranges: Range[]): Range[] {
  const s = [...ranges].sort((p, q) => p[0] - q[0]);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// The inbound port ranges an ACL lets in from the whole internet (0.0.0.0/0, or ::/0), evaluated in rule-number order:
// the first rule that matches a port decides it. ["all"] when every TCP and UDP port is allowed; [] when none is.
export function naclOpen(entries: RawNaclEntry[]): string[] {
  const inbound = entries.filter((e) => e.Egress !== true).sort((a, b) => (a.RuleNumber ?? 0) - (b.RuleNumber ?? 0));
  const allowed: Record<"tcp" | "udp", Range[]> = { tcp: [], udp: [] };
  for (const world of ["0.0.0.0/0", "::/0"]) {
    const rules = inbound.filter((e) => (world === "0.0.0.0/0" ? e.CidrBlock : e.Ipv6CidrBlock) === world);
    for (const proto of ["tcp", "udp"] as const) {
      let undecided: Range[] = [[0, 65535]];
      for (const e of rules) {
        const p = normProtocol(e.Protocol);
        if (p !== "all" && p !== proto) continue;
        const range: Range = p === "all" ? [0, 65535] : [e.PortRange?.From ?? 0, e.PortRange?.To ?? 65535];
        if (lower(e.RuleAction) === "allow") allowed[proto].push(...intersect(undecided, range));
        undecided = subtract(undecided, range);
        if (!undecided.length) break;
      }
    }
  }
  const tcp = merge(allowed.tcp), udp = merge(allowed.udp);
  const full = (r: Range[]) => r.length === 1 && r[0][0] === 0 && r[0][1] === 65535;
  if (full(tcp) && full(udp)) return ["all"];
  const fmt = (r: Range[], p: string) => r.map(([a, b]) => `${a === b ? a : `${a}-${b}`}/${p}`);
  return [...fmt(tcp, "tcp"), ...fmt(udp, "udp")];
}
export const naclFor = (subnetId: string | undefined, vpcId: string | undefined, nacls: RawNacl[]): RawNacl | undefined =>
  nacls.find((x) => x.Associations?.some((a) => a.SubnetId === subnetId)) ?? nacls.find((x) => x.VpcId === vpcId && x.IsDefault);

// ---------- health ----------

const h = (health: Health, healthReason?: string) => ({ health, ...(healthReason ? { healthReason } : {}) });
const IGNORED = new Set(["deleted", "deleting"]);
function natHealth(x: RawNat) {
  const s = lower(x.State);
  if (s === "available") return h("ok");
  if (s === "pending") return h("warning", "starting");
  if (s === "failed") return h("error", x.FailureMessage ? `failed: ${x.FailureMessage}` : "failed");
  if (s === "deleting") return h("stopped", "deleting");
  return h("unknown", s || undefined);
}
function endpointHealth(x: RawEndpoint) {
  const s = lower(x.State);
  if (s === "available") return h("ok");
  if (s === "pending" || s === "pendingacceptance" || s === "partial") return h("warning", s === "partial" ? "partially available" : s === "pendingacceptance" ? "waiting for the service owner to accept" : "pending");
  if (s === "failed" || s === "rejected" || s === "expired") return h("error", `${s}${x.LastError?.Message ? `: ${x.LastError.Message}` : ""}`);
  return h("unknown", s || undefined);
}
function peeringHealth(code: string, message?: string) {
  if (code === "active") return h("ok");
  if (code === "initiating-request" || code === "pending-acceptance" || code === "provisioning") return h("warning", message || code);
  if (code === "failed") return h("error", message || "failed");
  return h("unknown", code || undefined);
}
function tgwHealth(state: string) {
  if (state === "available") return h("ok");
  if (state.startsWith("initiating") || state.startsWith("pending") || state === "modifying" || state === "rollingback") return h("warning", state);
  if (state === "failed" || state === "failing" || state === "rejected" || state === "rejecting") return h("error", state);
  return h("unknown", state || undefined);
}
export function vpnHealth(v: Pick<RawVpn, "State" | "VgwTelemetry">) {
  const s = lower(v.State);
  if (s === "pending") return h("warning", "pending");
  if (s !== "available") return h("unknown", s || undefined);
  const t = v.VgwTelemetry ?? [];
  const down = t.filter((x) => lower(x.Status) !== "up");
  if (!t.length) return h("unknown", "no tunnel status");
  if (!down.length) return h("ok");
  if (down.length === t.length) return h("error", `all ${t.length} tunnels down`);
  return h("warning", `${down.length} of ${t.length} tunnels down`);
}

// Free addresses: below max(8, 5 % of the subnet's range) is a warning.
export function lowOnIps(cidr: string | undefined, free: number | undefined): boolean {
  const bits = Number(/\/(\d{1,2})$/.exec(cidr ?? "")?.[1]);
  if (!Number.isFinite(bits) || typeof free !== "number") return false;
  return free < Math.max(8, 0.05 * 2 ** (32 - bits));
}
// Named or tagged "private" (the Name tag, or any non-aws: tag value).
const namedPrivate = (tags: Record<string, string>) => Object.entries(tags).some(([k, v]) => !k.startsWith("aws:") && /\bprivate\b/i.test(v));

// ---------- resources ----------

export interface VpcOptions { region: string; accountId?: string; home?: string; now?: number }

export function vpcResults(raw: VpcRaw, o: VpcOptions): ProviderResult {
  const { region } = o;
  const home = o.home ?? region;
  const acct = (owner?: string) => owner || o.accountId || "";
  const resources: Resource[] = [];
  const links: Link[] = [];
  const stamp = o.now ? { observedAt: o.now } : {};
  const foreign = (owner?: string) => (o.accountId && owner && owner !== o.accountId ? { account: owner } : {});

  const vpcs = raw.vpcs.filter((v) => v?.VpcId);
  const vpcOwner = new Map(vpcs.map((v) => [v.VpcId!, acct(v.OwnerId)]));
  const vpcKey = (id: string, owner?: string) => arnOf.vpc(region, owner ?? vpcOwner.get(id) ?? acct(), id);
  const subnets = (raw.subnets ?? []).filter((s) => s?.SubnetId);
  const tables = raw.routeTables ?? [];
  const nacls = raw.nacls ?? [];
  const nats = (raw.natGateways ?? []).filter((x) => x.NatGatewayId && lower(x.State) !== "deleted");
  const peerings = (raw.peerings ?? []).filter((p) => p.VpcPeeringConnectionId && !["deleted", "deleting", "rejected", "expired"].includes(lower(p.Status?.Code)));
  const tgws = (raw.tgwAttachments ?? []).filter((x) => x.TransitGatewayAttachmentId && !IGNORED.has(lower(x.State)));
  const vpns = (raw.vpns ?? []).filter((v) => v.VpnConnectionId && !IGNORED.has(lower(v.State)));
  const endpoints = (raw.endpoints ?? []).filter((e) => e.VpcEndpointId && !IGNORED.has(lower(e.State)));
  const natKey = (id: string) => arnOf.natGateway(region, acct(), id);
  const peeringKey = (id: string) => arnOf.vpcPeering(region, acct(), id);
  const tgwKey = (id: string) => arnOf.transitGatewayAttachment(region, acct(), id);
  const vpnKey = (id: string) => arnOf.vpnConnection(region, acct(), id);
  const endpointKey = (id: string) => arnOf.vpcEndpoint(region, acct(), id);
  // The VPC a virtual private gateway serves: the VPC of the route tables that route to or propagate it.
  const vgwVpc = (vgw: string) => uniq(tables.filter((t) => t.PropagatingVgws?.some((p) => p.GatewayId === vgw) || t.Routes?.some((r) => r.GatewayId === vgw)).map((t) => t.VpcId));

  // Subnets first: the VPC rows summarise them.
  const classes = new Map<string, SubnetClass>();
  for (const s of subnets) {
    const id = s.SubnetId!;
    const tags = tagMap(s.Tags ?? []);
    const owner = acct(s.OwnerId);
    const key = arnOf.subnet(region, owner, id);
    const { table, main } = raw.routeTables ? effectiveTable(s, tables) : { table: undefined, main: false };
    const c = table ? classify(table.Routes ?? []) : undefined;
    if (c) classes.set(id, c.class);
    const nacl = raw.nacls ? naclFor(id, s.VpcId, nacls) : undefined;
    const open = nacl ? naclOpen(nacl.Entries ?? []) : undefined;
    const routes = (table?.Routes ?? []).filter(active);
    const gatewayEndpoints = routes.filter((r) => r.DestinationPrefixListId && r.GatewayId?.startsWith("vpce-")).map((r) => `${r.DestinationPrefixListId} → ${r.GatewayId}`);
    const other = routes.filter((r) => !r.DestinationPrefixListId && r.GatewayId !== "local" && r.DestinationCidrBlock !== "0.0.0.0/0" && r.DestinationIpv6CidrBlock !== "::/0").map((r) => `${destination(r)} → ${routeTarget(r) ?? "?"}`);
    const problems: string[] = [];
    if (c?.class === "public" && namedPrivate(tags)) problems.push(`named private but routes ${c.route} to ${c.target}`);
    if (lowOnIps(s.CidrBlock, s.AvailableIpAddressCount)) problems.push(`only ${n(s.AvailableIpAddressCount!)} free IP addresses left`);
    if (lower(s.State) === "pending") problems.push("pending");
    const p: Prop[] = props(
      prop("Subnet id", id, true), prop("CIDR", s.CidrBlock, true), prop("IPv6 CIDR", (s.Ipv6CidrBlockAssociationSet ?? []).map((x) => x.Ipv6CidrBlock).filter(Boolean).join(", "), true),
      prop("Availability zone", s.AvailabilityZone), prop("Class", c ? c.label : raw.routeTables ? "no route table" : "unknown (route tables not read)"),
      prop("Route table", table?.RouteTableId ? `${table.RouteTableId}${main ? " (main)" : ""}` : undefined, true),
      prop("Other routes", other.join(", ")), prop("Gateway endpoints", gatewayEndpoints.join(", ")),
      prop("Network ACL", nacl?.NetworkAclId ? `${nacl.NetworkAclId}${nacl.IsDefault ? " (default)" : ""} — from the internet: ${open?.length ? open.join(", ") : "nothing"}` : undefined),
      prop("Free IP addresses", typeof s.AvailableIpAddressCount === "number" ? n(s.AvailableIpAddressCount) : undefined),
      prop("Public IP on launch", s.MapPublicIpOnLaunch === undefined ? undefined : s.MapPublicIpOnLaunch ? "yes" : "no"),
      s.DefaultForAz ? prop("Default subnet", "yes") : undefined,
    );
    resources.push({
      key, kind: "subnet", provider: "vpc", name: nameOf(tags, id), region, tags, ...h(problems.length ? "warning" : "ok", problems.join(" · ") || undefined),
      props: p, aliases: [id], ...(s.VpcId ? { vpcId: s.VpcId, parent: vpcKey(s.VpcId, owner) } : {}),
      consoleUrl: consoleUrl(region, `SubnetDetails:subnetId=${id}`),
      ...((c || open) ? { facts: { ...(c ? { routesToIgw: c.routesToIgw } : {}), ...(open ? { naclOpen: open } : {}) } } : {}),
      ...foreign(s.OwnerId), ...stamp,
    });
    // Where the default route goes, when that is a node here.
    if (c?.target && c.class !== "public" && c.class !== "isolated") {
      const t = c.target;
      const to = t.startsWith("nat-") ? natKey(t)
        : t.startsWith("pcx-") ? peeringKey(t)
          : t.startsWith("vpce-") ? endpointKey(t)
            : t.startsWith("i-") ? keys.ec2(t, region, home)
              : t.startsWith("tgw-") ? (() => { const a = tgws.find((x) => x.TransitGatewayId === t && x.ResourceId === s.VpcId); return a ? tgwKey(a.TransitGatewayAttachmentId!) : undefined; })()
                : t.startsWith("vgw-") ? (() => { const v = vpns.find((x) => x.VpnGatewayId === t); return v ? vpnKey(v.VpnConnectionId!) : undefined; })()
                  : undefined;
      if (to) links.push({ from: key, to, kind: "route", label: c.route, evidence: `route table ${table?.RouteTableId ?? "?"}: default route → ${t}` });
    }
  }

  // VPCs.
  const flowLogs = raw.flowLogs ?? [];
  for (const v of vpcs) {
    const id = v.VpcId!;
    const tags = tagMap(v.Tags ?? []);
    const owner = acct(v.OwnerId);
    const key = arnOf.vpc(region, owner, id);
    const cidrs = uniq([v.CidrBlock, ...(v.CidrBlockAssociationSet ?? []).filter((x) => ["associated", ""].includes(lower(x.CidrBlockState?.State))).map((x) => x.CidrBlock)]);
    const v6 = uniq((v.Ipv6CidrBlockAssociationSet ?? []).filter((x) => ["associated", ""].includes(lower(x.Ipv6CidrBlockState?.State))).map((x) => x.Ipv6CidrBlock));
    const mine = subnets.filter((s) => s.VpcId === id);
    const byClass = new Map<string, number>();
    for (const s of mine) {
      const c = classes.get(s.SubnetId!);
      const label = c ? CLASS_LABEL[c].toLowerCase() : "unknown";
      byClass.set(label, (byClass.get(label) ?? 0) + 1);
    }
    const logs = flowLogs.filter((f) => f.ResourceId === id);
    const failing = logs.filter((f) => lower(f.DeliverLogsStatus) === "failed");
    const rtbs = tables.filter((t) => t.VpcId === id && t.RouteTableId);
    const acls = nacls.filter((x) => x.VpcId === id && x.NetworkAclId);
    const p: Prop[] = props(
      prop("VPC id", id, true), prop("CIDR", cidrs.join(", "), true), prop("IPv6 CIDR", v6.join(", "), true),
      prop("Subnets", raw.subnets ? `${mine.length}${byClass.size ? ` — ${[...byClass].map(([k, c]) => `${c} ${k}`).join(", ")}` : ""}` : undefined),
      v.IsDefault ? prop("Default VPC", "yes") : undefined, prop("DHCP options", v.DhcpOptionsId, true),
      prop("Tenancy", v.InstanceTenancy && v.InstanceTenancy !== "default" ? v.InstanceTenancy : undefined),
      raw.flowLogs ? prop("Flow logs", logs.length ? logs.map((f) => `${f.LogGroupName ?? f.LogDestination ?? "?"} (${f.TrafficType ?? "?"})`).join(", ") : "none") : undefined,
    );
    const problems = [...(lower(v.State) === "pending" ? ["pending"] : []), ...(failing.length ? [`flow log delivery failing (${failing.map((f) => f.FlowLogId).join(", ")})`] : [])];
    resources.push({
      key, kind: "vpc", provider: "vpc", name: nameOf(tags, id), region, tags, ...h(problems.length ? "warning" : "ok", problems.join(" · ") || undefined), props: p,
      // Route tables and network ACLs aren't nodes: Resource Explorer's rows for them fold into their VPC.
      aliases: uniq([id, ...rtbs.flatMap((t) => [t.RouteTableId, arnOf.routeTable(region, acct(t.OwnerId), t.RouteTableId!)]), ...acls.flatMap((x) => [x.NetworkAclId, arnOf.networkAcl(region, acct(x.OwnerId), x.NetworkAclId!)])]),
      consoleUrl: consoleUrl(region, `VpcDetails:VpcId=${id}`), facts: { cidrs, ...(v.IsDefault ? { isDefault: true } : {}) }, ...foreign(v.OwnerId), ...stamp,
    });
  }

  // Flow logs → their destination (log group, bucket or Firehose stream).
  for (const f of flowLogs) {
    const from = f.ResourceId?.startsWith("vpc-") ? vpcKey(f.ResourceId) : f.ResourceId?.startsWith("subnet-") ? (() => { const s = subnets.find((x) => x.SubnetId === f.ResourceId); return s ? arnOf.subnet(region, acct(s.OwnerId), s.SubnetId!) : undefined; })() : undefined;
    const dest = f.LogDestination?.startsWith("arn:aws") && /:s3:::/.test(f.LogDestination) ? `arn:${partitionOf(region)}:s3:::${f.LogDestination.split(":::")[1].split("/")[0]}`
      : f.LogDestination?.startsWith("arn:") ? arnBase(f.LogDestination)
        : f.LogGroupName && acct() ? arnOf.logGroup(region, acct(), f.LogGroupName) : undefined;
    if (from && dest) links.push({ from, to: dest, kind: "logs", label: `flow logs (${lower(f.TrafficType) || "all"})`, evidence: `VPC flow log ${f.FlowLogId ?? ""}`.trim() });
  }

  // NAT gateways (in a subnet), with the Elastic IPs they use as aliases.
  const natAllocations = new Set<string>(), natInterfaces = new Set<string>();
  for (const x of nats) {
    const id = x.NatGatewayId!;
    const tags = tagMap(x.Tags ?? []);
    const addrs = x.NatGatewayAddresses ?? [];
    for (const a of addrs) {
      if (a.AllocationId) natAllocations.add(a.AllocationId);
      if (a.NetworkInterfaceId) natInterfaces.add(a.NetworkInterfaceId);
    }
    const subnet = subnets.find((s) => s.SubnetId === x.SubnetId);
    resources.push({
      key: natKey(id), kind: "nat-gateway", provider: "vpc", name: nameOf(tags, id), region, tags, ...natHealth(x),
      props: props(
        prop("NAT gateway id", id, true), prop("Connectivity", x.ConnectivityType === "private" ? "private (no internet)" : "public"),
        prop("Public IP", uniq(addrs.map((a) => a.PublicIp)).join(", "), true), prop("Private IP", uniq(addrs.map((a) => a.PrivateIp)).join(", "), true), prop("Subnet", x.SubnetId, true),
      ),
      aliases: uniq([id, ...addrs.flatMap((a) => (a.AllocationId ? [a.AllocationId, arnOf.eip(region, acct(), a.AllocationId)] : []))]),
      ...(x.VpcId ? { vpcId: x.VpcId } : {}), ...(x.SubnetId ? { subnetIds: [x.SubnetId], parent: arnOf.subnet(region, acct(subnet?.OwnerId), x.SubnetId) } : {}),
      consoleUrl: consoleUrl(region, `NatGatewayDetails:natGatewayId=${id}`), ...(ms(x.CreateTime) ? { createdAt: ms(x.CreateTime) } : {}), ...stamp,
    });
  }

  // Internet gateways and egress-only internet gateways (in their VPC).
  const gateway = (id: string, key: string, kindLabel: string, tagsRaw: Tags | undefined, attachments: { State?: string; VpcId?: string }[] | undefined, owner: string | undefined, hash: string) => {
    const tags = tagMap(tagsRaw ?? []);
    const att = (attachments ?? []).find((a) => a.VpcId && lower(a.State) !== "detached");
    resources.push({
      key, kind: "internet-gateway", provider: "vpc", name: nameOf(tags, id), region, tags, ...(att ? h("ok") : h("warning", "not attached to a VPC")),
      props: props(prop("Gateway id", id, true), prop("Type", kindLabel), prop("VPC", att?.VpcId, true)),
      aliases: [id], ...(att?.VpcId ? { vpcId: att.VpcId, parent: vpcKey(att.VpcId) } : {}), consoleUrl: consoleUrl(region, hash), ...foreign(owner), ...stamp,
    });
  };
  for (const x of raw.internetGateways ?? [])
    if (x.InternetGatewayId) gateway(x.InternetGatewayId, arnOf.internetGateway(region, acct(x.OwnerId), x.InternetGatewayId), "Internet gateway", x.Tags, x.Attachments, x.OwnerId, `InternetGateway:internetGatewayId=${x.InternetGatewayId}`);
  for (const x of raw.egressOnly ?? [])
    if (x.EgressOnlyInternetGatewayId)
      gateway(x.EgressOnlyInternetGatewayId, arnOf.egressOnlyInternetGateway(region, acct(x.OwnerId), x.EgressOnlyInternetGatewayId), "Egress-only (IPv6 outbound only)", x.Tags, x.Attachments, x.OwnerId, `EgressOnlyInternetGateways:egressOnlyInternetGatewayId=${x.EgressOnlyInternetGatewayId}`);

  // VPC endpoints.
  for (const e of endpoints) {
    const id = e.VpcEndpointId!;
    const tags = tagMap(e.Tags ?? []);
    const service = e.ServiceName?.replace(/^com\.amazonaws\.(vpce\.)?[a-z0-9-]+\./, "") ?? "";
    const type = lower(e.VpcEndpointType);
    resources.push({
      key: endpointKey(id), kind: "vpc-endpoint", provider: "vpc", name: tags.Name?.trim() || `${service || id} (${type || "endpoint"})`, region, tags, ...endpointHealth(e),
      props: props(
        prop("Endpoint id", id, true), prop("Service", e.ServiceName, true), prop("Type", e.VpcEndpointType),
        prop("Route tables", (e.RouteTableIds ?? []).join(", "), true), prop("Subnets", (e.SubnetIds ?? []).join(", "), true),
        type === "interface" ? prop("Private DNS", e.PrivateDnsEnabled ? "on" : "off") : undefined,
      ),
      aliases: [id], ...(e.VpcId ? { vpcId: e.VpcId, parent: vpcKey(e.VpcId) } : {}),
      ...((e.SubnetIds ?? []).length ? { subnetIds: [...e.SubnetIds!] } : {}),
      ...((e.Groups ?? []).length ? { securityGroups: e.Groups!.map((g) => g.GroupId!).filter(Boolean) } : {}),
      ...((e.DnsEntries ?? []).length ? { endpoints: uniq(e.DnsEntries!.map((d) => d.DnsName?.replace(/^\*\./, "").toLowerCase())) } : {}),
      consoleUrl: consoleUrl(region, `EndpointDetails:vpcEndpointId=${id}`), ...(ms(e.CreationTimestamp) ? { createdAt: ms(e.CreationTimestamp) } : {}), ...foreign(e.OwnerId), ...stamp,
    });
  }

  // Peerings: one node, linked to both VPCs (in whichever account or region they are).
  for (const x of peerings) {
    const id = x.VpcPeeringConnectionId!;
    const tags = tagMap(x.Tags ?? []);
    const side = (v?: RawPeerVpc) => (v?.VpcId ? arnOf.vpc(v.Region || region, v.OwnerId || acct(), v.VpcId) : undefined);
    const describe = (v?: RawPeerVpc) =>
      v?.VpcId ? `${v.VpcId} (${uniq([v.CidrBlock, ...(v.CidrBlockSet ?? []).map((c) => c.CidrBlock)]).join(", ") || "?"})${v.OwnerId && v.OwnerId !== o.accountId ? ` · account ${v.OwnerId}` : ""}${v.Region && v.Region !== region ? ` · ${v.Region}` : ""}` : undefined;
    const via = tables.filter((t) => t.Routes?.some((r) => r.VpcPeeringConnectionId === id && active(r)));
    const routeEvidence = via.map((t) => `route table ${t.RouteTableId} in ${t.VpcId} sends ${(t.Routes ?? []).filter((r) => r.VpcPeeringConnectionId === id).map(destination).join(", ")} here`);
    const key = peeringKey(id);
    resources.push({
      key, kind: "vpc-peering", provider: "vpc", name: nameOf(tags, id), region, tags, ...peeringHealth(lower(x.Status?.Code), x.Status?.Message),
      props: props(prop("Peering id", id, true), prop("Requester", describe(x.RequesterVpcInfo), true), prop("Accepter", describe(x.AccepterVpcInfo), true), prop("Routes", via.length ? routeEvidence.join("; ") : "no route table uses it")),
      aliases: [id], consoleUrl: consoleUrl(region, `PeeringConnectionDetails:VpcPeeringConnectionId=${id}`), ...stamp,
    });
    for (const [role, v] of [["requester", x.RequesterVpcInfo], ["accepter", x.AccepterVpcInfo]] as const) {
      const to = side(v);
      if (to) links.push({ from: key, to, kind: "route", label: "peering", evidence: [`VPC peering ${id} (${role})`, ...routeEvidence.filter((e) => e.includes(` in ${v?.VpcId} `))].join("; ") });
    }
  }

  // Transit gateway attachments → the VPC they attach.
  for (const x of tgws) {
    const id = x.TransitGatewayAttachmentId!;
    const tags = tagMap(x.Tags ?? []);
    const key = tgwKey(id);
    resources.push({
      key, kind: "transit-gateway-attachment", provider: "vpc", name: nameOf(tags, id), region, tags, ...tgwHealth(lower(x.State)),
      props: props(prop("Attachment id", id, true), prop("Transit gateway", x.TransitGatewayId, true), prop("Attaches", x.ResourceType && x.ResourceId ? `${x.ResourceType} ${x.ResourceId}` : x.ResourceType), prop("Transit gateway owner", x.TransitGatewayOwnerId && x.TransitGatewayOwnerId !== o.accountId ? x.TransitGatewayOwnerId : undefined)),
      aliases: [id], ...(x.ResourceType === "vpc" && x.ResourceId ? { vpcId: x.ResourceId } : {}),
      consoleUrl: consoleUrl(region, `TransitGatewayAttachmentDetails:transitGatewayAttachmentId=${id}`), ...(ms(x.CreationTime) ? { createdAt: ms(x.CreationTime) } : {}),
      ...foreign(x.ResourceOwnerId), ...stamp,
    });
    if (x.ResourceType === "vpc" && x.ResourceId)
      links.push({ from: key, to: arnOf.vpc(region, x.ResourceOwnerId || acct(), x.ResourceId), kind: "route", label: x.TransitGatewayId ?? "transit gateway", evidence: `transit gateway attachment ${id}` });
  }

  // VPN connections: health from the tunnels' telemetry.
  for (const raw0 of vpns) {
    const v = vpnView(raw0);
    const id = v.VpnConnectionId!;
    const tags = tagMap(v.Tags ?? []);
    const vpc = v.VpnGatewayId ? vgwVpc(v.VpnGatewayId) : [];
    resources.push({
      key: vpnKey(id), kind: "vpn-connection", provider: "vpc", name: nameOf(tags, id), region, tags, ...vpnHealth(v),
      props: props(
        prop("VPN connection id", id, true), prop("Customer gateway", v.CustomerGatewayId, true), prop("Gateway", v.VpnGatewayId ?? v.TransitGatewayId, true),
        prop("Tunnels", (v.VgwTelemetry ?? []).map((x) => `${x.OutsideIpAddress ?? "?"} ${x.Status ?? "?"}`).join(", ")), prop("Type", v.Type),
      ),
      aliases: [id], ...(vpc.length === 1 ? { vpcId: vpc[0] } : {}), consoleUrl: consoleUrl(region, `VpnConnectionDetails:vpnConnectionId=${id}`), ...stamp,
    });
  }

  // Elastic IPs: unattached ones are nodes; a NAT gateway's are its aliases; the rest are hidden rows.
  for (const a of raw.addresses ?? []) {
    if (!a.AllocationId) continue;
    if (natAllocations.has(a.AllocationId) || (a.NetworkInterfaceId && natInterfaces.has(a.NetworkInterfaceId))) continue;
    const tags = tagMap(a.Tags ?? []);
    const key = arnOf.eip(region, acct(), a.AllocationId);
    const loose = !a.AssociationId && !a.ServiceManaged;
    const usedBy = a.InstanceId ? `instance ${a.InstanceId}` : a.ServiceManaged ? `${a.ServiceManaged} (managed by AWS)` : a.NetworkInterfaceId ? `network interface ${a.NetworkInterfaceId}` : undefined;
    resources.push({
      key, kind: "elastic-ip", provider: "vpc", name: tags.Name?.trim() || a.PublicIp || a.AllocationId, region, tags,
      ...(loose ? h("warning", "not attached — billed hourly") : h("ok")),
      props: props(prop("Public IP", a.PublicIp, true), prop("Allocation id", a.AllocationId, true), prop("Associated with", usedBy ?? (loose ? "nothing" : undefined)), prop("Private IP", a.PrivateIpAddress, true)),
      aliases: [a.AllocationId], ...(loose && a.PublicIp ? { endpoints: [a.PublicIp] } : {}),
      ...(loose ? {} : { hidden: true }), ...(a.InstanceId ? { parent: keys.ec2(a.InstanceId, region, home) } : {}),
      consoleUrl: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#ElasticIpDetails:AllocationId=${a.AllocationId}`, ...stamp,
    });
  }

  return { resources, links, mentions: [] };
}

// ---------- detail ----------

const routesLine = (t: RawRouteTable) => (t.Routes ?? []).filter((r) => r.GatewayId !== "local").map((r) => `${destination(r)} → ${routeTarget(r) ?? "?"}${active(r) ? "" : " (blackhole)"}`).join("; ") || "local only";

// The VPC panel: its subnets with their class, route tables, network ACLs, gateways and endpoints, peerings and VPNs,
// flow logs. `raw` may hold the whole region; only this VPC's parts are shown.
export function vpcDetail(key: string, vpcId: string, raw: VpcRaw): ResourceDetail {
  const tables = (raw.routeTables ?? []).filter((t) => t.VpcId === vpcId);
  const subnets = (raw.subnets ?? []).filter((s) => s.VpcId === vpcId);
  const nacls = (raw.nacls ?? []).filter((x) => x.VpcId === vpcId);
  const sections: ResourceDetail["sections"] = [];
  if (raw.subnets)
    sections.push({
      title: "Subnets", table: {
        columns: ["Name", "Subnet", "Zone", "CIDR", "Class", "Free IPs"],
        rows: subnets.map((s) => {
          const { table } = effectiveTable(s, tables);
          return [tagMap(s.Tags ?? []).Name ?? "", s.SubnetId!, s.AvailabilityZone ?? "", s.CidrBlock ?? "", table ? classify(table.Routes ?? []).label : "unknown", typeof s.AvailableIpAddressCount === "number" ? n(s.AvailableIpAddressCount) : ""];
        }),
      },
    });
  if (raw.routeTables)
    sections.push({
      title: "Route tables", table: {
        columns: ["Route table", "Main", "Subnets", "Routes"],
        rows: tables.map((t) => [t.RouteTableId ?? "", t.Associations?.some((a) => a.Main) ? "yes" : "", (t.Associations ?? []).map((a) => a.SubnetId).filter(Boolean).join(", "), routesLine(t)]),
      },
    });
  if (raw.nacls)
    sections.push({
      title: "Network ACLs", table: {
        columns: ["ACL", "Default", "Subnets", "Open from the internet"],
        rows: nacls.map((x) => [x.NetworkAclId ?? "", x.IsDefault ? "yes" : "", (x.Associations ?? []).map((a) => a.SubnetId).filter(Boolean).join(", "), naclOpen(x.Entries ?? []).join(", ") || "nothing"]),
      },
    });
  const gw: string[][] = [
    ...(raw.internetGateways ?? []).filter((x) => x.Attachments?.some((a) => a.VpcId === vpcId)).map((x) => ["Internet gateway", x.InternetGatewayId ?? "", tagMap(x.Tags ?? []).Name ?? "", x.Attachments?.[0]?.State ?? ""]),
    ...(raw.egressOnly ?? []).filter((x) => x.Attachments?.some((a) => a.VpcId === vpcId)).map((x) => ["Egress-only gateway", x.EgressOnlyInternetGatewayId ?? "", tagMap(x.Tags ?? []).Name ?? "", x.Attachments?.[0]?.State ?? ""]),
    ...(raw.natGateways ?? []).filter((x) => x.VpcId === vpcId && lower(x.State) !== "deleted").map((x) => ["NAT gateway", x.NatGatewayId ?? "", tagMap(x.Tags ?? []).Name ?? "", lower(x.State)]),
    ...(raw.endpoints ?? []).filter((x) => x.VpcId === vpcId && !IGNORED.has(lower(x.State))).map((x) => [`Endpoint (${lower(x.VpcEndpointType)})`, x.VpcEndpointId ?? "", x.ServiceName ?? "", lower(x.State)]),
  ];
  if (gw.length) sections.push({ title: "Gateways and endpoints", table: { columns: ["Kind", "Id", "Name / service", "State"], rows: gw } });
  const vgws = new Set(tables.flatMap((t) => [...(t.PropagatingVgws ?? []).map((p) => p.GatewayId), ...(t.Routes ?? []).map((r) => r.GatewayId)]).filter((x): x is string => !!x?.startsWith("vgw-")));
  const links: string[][] = [
    ...(raw.peerings ?? []).filter((p) => p.RequesterVpcInfo?.VpcId === vpcId || p.AccepterVpcInfo?.VpcId === vpcId).map((p) => {
      const other = p.RequesterVpcInfo?.VpcId === vpcId ? p.AccepterVpcInfo : p.RequesterVpcInfo;
      return ["Peering", p.VpcPeeringConnectionId ?? "", `${other?.VpcId ?? "?"} (${other?.CidrBlock ?? "?"})`, lower(p.Status?.Code)];
    }),
    ...(raw.tgwAttachments ?? []).filter((x) => x.ResourceType === "vpc" && x.ResourceId === vpcId).map((x) => ["Transit gateway", x.TransitGatewayAttachmentId ?? "", x.TransitGatewayId ?? "", lower(x.State)]),
    ...(raw.vpns ?? []).filter((v) => v.VpnGatewayId && vgws.has(v.VpnGatewayId)).map((v) => ["VPN", v.VpnConnectionId ?? "", v.CustomerGatewayId ?? "", vpnHealth(v).healthReason ?? lower(v.State)]),
  ];
  if (links.length) sections.push({ title: "Peerings, transit gateways and VPNs", table: { columns: ["Kind", "Id", "Other side", "State"], rows: links } });
  const logs = (raw.flowLogs ?? []).filter((f) => f.ResourceId === vpcId || subnets.some((s) => s.SubnetId === f.ResourceId));
  if (raw.flowLogs) sections.push({ title: "Flow logs", ...(logs.length ? { table: { columns: ["Flow log", "Of", "Destination", "Traffic", "Delivery"], rows: logs.map((f) => [f.FlowLogId ?? "", f.ResourceId ?? "", f.LogGroupName ?? f.LogDestination ?? "", f.TrafficType ?? "", f.DeliverLogsStatus ?? ""]) } } : { note: "No flow logs: traffic in this VPC isn't recorded." }) });
  return { key, sections };
}

// The subnet panel: its routes and its network ACL's inbound rules.
export function subnetDetail(key: string, subnetId: string, raw: VpcRaw): ResourceDetail {
  const s = (raw.subnets ?? []).find((x) => x.SubnetId === subnetId);
  const sections: ResourceDetail["sections"] = [];
  const { table, main } = s ? effectiveTable(s, raw.routeTables ?? []) : { table: undefined, main: false };
  if (table)
    sections.push({
      title: `Routes (${table.RouteTableId}${main ? ", the VPC's main table" : ""})`,
      table: { columns: ["Destination", "Target", "State"], rows: (table.Routes ?? []).map((r) => [destination(r), routeTarget(r) ?? "?", lower(r.State) || "active"]) },
    });
  const nacl = s ? naclFor(s.SubnetId, s.VpcId, raw.nacls ?? []) : undefined;
  if (nacl)
    sections.push({
      title: `Network ACL ${nacl.NetworkAclId}${nacl.IsDefault ? " (default)" : ""} — inbound`,
      table: {
        columns: ["Rule", "Protocol", "Ports", "Source", "Action"],
        rows: (nacl.Entries ?? []).filter((e) => !e.Egress).sort((a, b) => (a.RuleNumber ?? 0) - (b.RuleNumber ?? 0)).map((e) => {
          const p = normProtocol(e.Protocol);
          return [e.RuleNumber === 32767 ? "*" : String(e.RuleNumber ?? ""), p, p === "all" || !e.PortRange ? "all" : e.PortRange.From === e.PortRange.To ? String(e.PortRange.From) : `${e.PortRange.From}-${e.PortRange.To}`, e.CidrBlock ?? e.Ipv6CidrBlock ?? "", lower(e.RuleAction)];
        }),
      },
    });
  return { key, sections };
}
