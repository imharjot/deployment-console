// Simulated VPC networking, per region (the provider sets multiRegionMock), in the SDK's shapes so the real mapping
// runs (mock-names NETWORK and EU). us-east-1: production has public subnets for the load balancer (internet gateway)
// and private ones for tasks and data that leave through a NAT gateway, reach S3 through a gateway endpoint, the
// shared transit gateway and the office VPN (one tunnel down: a warning); a stricter network ACL guards them. Staging
// has one public subnet for the ECS host and two subnets *named* private that still use the main route table's
// default route to the internet gateway — acme-staging-pg lives there, so its open group is an exposure error. The two
// VPCs are peered; production's flow logs go to CloudWatch Logs; one Elastic IP is attached to nothing. eu-west-1: one
// VPC with two isolated subnets (the eu ECS services and database), untagged: they take the eu environment from what
// runs in them. Other regions: nothing.
import type { RawNaclEntry, VpcRaw } from "../../../inventory/vpc.ts";
import { ACCT, EC2, EU, EU_REGION, NETWORK, REGION } from "../mock-names.ts";

const tags = (o: Record<string, string>) => Object.entries(o).map(([Key, Value]) => ({ Key, Value }));
const P = NETWORK.production, S = NETWORK.staging;
const VGW = "vgw-0acme0office0001";
const NAT_EIP = { allocation: "eipalloc-0acme0nat0prod001", ip: "203.0.113.30" };
const local = (cidr: string) => ({ DestinationCidrBlock: cidr, GatewayId: "local", State: "active" });
const rule = (n: number, action: "allow" | "deny", o: Partial<RawNaclEntry> = {}): RawNaclEntry => ({ RuleNumber: n, Egress: false, Protocol: "-1", RuleAction: action, CidrBlock: "0.0.0.0/0", ...o });
const OPEN: RawNaclEntry[] = [rule(100, "allow"), rule(32767, "deny"), rule(100, "allow", { Egress: true }), rule(32767, "deny", { Egress: true })];
const subnet = (id: string, vpc: string, cidr: string, az: string, name: string, free: number, publicIp: boolean, env?: string) => ({
  SubnetId: id, VpcId: vpc, OwnerId: ACCT, CidrBlock: cidr, AvailabilityZone: az, AvailableIpAddressCount: free, MapPublicIpOnLaunch: publicIp, DefaultForAz: false, State: "available",
  Tags: tags({ Name: name, ...(env ? { Environment: env } : {}) }),
});

function home(): VpcRaw {
  return {
    vpcs: [
      { VpcId: P.vpc, OwnerId: ACCT, CidrBlock: P.cidr, CidrBlockAssociationSet: [{ CidrBlock: P.cidr, CidrBlockState: { State: "associated" } }], State: "available", IsDefault: false, DhcpOptionsId: "dopt-0acme0default01", InstanceTenancy: "default", Tags: tags({ Name: P.name, Environment: "production" }) },
      { VpcId: S.vpc, OwnerId: ACCT, CidrBlock: S.cidr, CidrBlockAssociationSet: [{ CidrBlock: S.cidr, CidrBlockState: { State: "associated" } }], State: "available", IsDefault: false, DhcpOptionsId: "dopt-0acme0default01", InstanceTenancy: "default", Tags: tags({ Name: S.name, Environment: "staging" }) },
    ],
    subnets: [
      subnet(P.publicSubnets[0], P.vpc, "10.20.0.0/24", `${REGION}a`, `${P.name}-public-a`, 244, true, "production"),
      subnet(P.publicSubnets[1], P.vpc, "10.20.1.0/24", `${REGION}b`, `${P.name}-public-b`, 247, true, "production"),
      subnet(P.privateSubnets[0], P.vpc, "10.20.10.0/24", `${REGION}a`, `${P.name}-private-a`, 236, false, "production"),
      subnet(P.privateSubnets[1], P.vpc, "10.20.11.0/24", `${REGION}b`, `${P.name}-private-b`, 239, false, "production"),
      subnet(S.publicSubnets[0], S.vpc, "10.30.0.0/24", `${REGION}a`, `${S.name}-public-a`, 248, true, "staging"),
      subnet(S.namedPrivateSubnets[0], S.vpc, "10.30.10.0/24", `${REGION}a`, `${S.name}-private-a`, 249, false, "staging"),
      subnet(S.namedPrivateSubnets[1], S.vpc, "10.30.11.0/24", `${REGION}b`, `${S.name}-private-b`, 250, false, "staging"),
    ],
    routeTables: [
      {
        RouteTableId: P.routeTables.public, VpcId: P.vpc, OwnerId: ACCT, Associations: P.publicSubnets.map((SubnetId) => ({ SubnetId, Main: false })),
        Routes: [local(P.cidr), { DestinationCidrBlock: "0.0.0.0/0", GatewayId: P.igw, State: "active" }], Tags: tags({ Name: `${P.name}-public` }),
      },
      {
        RouteTableId: P.routeTables.private, VpcId: P.vpc, OwnerId: ACCT, Associations: [{ Main: true }, ...P.privateSubnets.map((SubnetId) => ({ SubnetId, Main: false }))],
        Routes: [
          local(P.cidr), { DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: P.nat, State: "active" }, { DestinationPrefixListId: "pl-63a5400a", GatewayId: P.s3Endpoint, State: "active" },
          { DestinationCidrBlock: S.cidr, VpcPeeringConnectionId: NETWORK.peering.id, State: "active" },
          { DestinationCidrBlock: "10.99.0.0/16", TransitGatewayId: NETWORK.transitGatewayAttachment.tgw, State: "active" },
          { DestinationCidrBlock: "192.168.0.0/16", GatewayId: VGW, State: "active" },
        ],
        PropagatingVgws: [{ GatewayId: VGW }], Tags: tags({ Name: `${P.name}-private` }),
      },
      {
        // Staging's main table: everything without an explicit association — the subnets *named* private too.
        RouteTableId: S.routeTables.public, VpcId: S.vpc, OwnerId: ACCT, Associations: [{ Main: true }, { SubnetId: S.publicSubnets[0], Main: false }],
        Routes: [local(S.cidr), { DestinationCidrBlock: "0.0.0.0/0", GatewayId: S.igw, State: "active" }, { DestinationCidrBlock: P.cidr, VpcPeeringConnectionId: NETWORK.peering.id, State: "active" }],
        Tags: tags({ Name: `${S.name}-public` }),
      },
    ],
    natGateways: [{
      NatGatewayId: P.nat, SubnetId: P.publicSubnets[0], VpcId: P.vpc, State: "available", ConnectivityType: "public", CreateTime: "2025-03-02T10:00:00.000Z",
      NatGatewayAddresses: [{ AllocationId: NAT_EIP.allocation, PublicIp: NAT_EIP.ip, PrivateIp: "10.20.0.9", NetworkInterfaceId: "eni-0acme0nat0prod001" }], Tags: tags({ Name: `${P.name}-nat-a` }),
    }],
    internetGateways: [
      { InternetGatewayId: P.igw, OwnerId: ACCT, Attachments: [{ State: "available", VpcId: P.vpc }], Tags: tags({ Name: `${P.name}-igw` }) },
      { InternetGatewayId: S.igw, OwnerId: ACCT, Attachments: [{ State: "available", VpcId: S.vpc }], Tags: tags({ Name: `${S.name}-igw` }) },
    ],
    egressOnly: [],
    endpoints: [{
      VpcEndpointId: P.s3Endpoint, VpcEndpointType: "Gateway", VpcId: P.vpc, ServiceName: `com.amazonaws.${REGION}.s3`, State: "available", RouteTableIds: [P.routeTables.private],
      SubnetIds: [], Groups: [], PrivateDnsEnabled: false, DnsEntries: [], OwnerId: ACCT, CreationTimestamp: "2025-03-02T10:05:00.000Z", Tags: tags({ Name: `${P.name}-s3` }),
    }],
    peerings: [{
      VpcPeeringConnectionId: NETWORK.peering.id, Status: { Code: "active", Message: "Active" }, Tags: tags({ Name: "staging-to-production" }),
      RequesterVpcInfo: { VpcId: NETWORK.peering.requester, OwnerId: ACCT, Region: REGION, CidrBlock: S.cidr, CidrBlockSet: [{ CidrBlock: S.cidr }] },
      AccepterVpcInfo: { VpcId: NETWORK.peering.accepter, OwnerId: ACCT, Region: REGION, CidrBlock: P.cidr, CidrBlockSet: [{ CidrBlock: P.cidr }] },
    }],
    tgwAttachments: [{
      TransitGatewayAttachmentId: NETWORK.transitGatewayAttachment.id, TransitGatewayId: NETWORK.transitGatewayAttachment.tgw, TransitGatewayOwnerId: ACCT,
      ResourceOwnerId: ACCT, ResourceType: "vpc", ResourceId: NETWORK.transitGatewayAttachment.vpc, State: "available", CreationTime: "2025-06-10T08:00:00.000Z", Tags: tags({ Name: "acme-shared-network" }),
    }],
    addresses: [
      { AllocationId: NETWORK.unattachedEip.allocationId, PublicIp: NETWORK.unattachedEip.ip, Domain: "vpc", Tags: tags({ Name: "acme-old-ip" }) },
      { AllocationId: NAT_EIP.allocation, AssociationId: "eipassoc-0acme0nat0prod01", PublicIp: NAT_EIP.ip, NetworkInterfaceId: "eni-0acme0nat0prod001", PrivateIpAddress: "10.20.0.9", Domain: "vpc" },
      { AllocationId: "eipalloc-0acme0bastion001", AssociationId: "eipassoc-0acme0bastion01", PublicIp: EC2.bastion.publicIp, InstanceId: EC2.bastion.id, Domain: "vpc", Tags: tags({ Name: EC2.bastion.name }) },
    ],
    flowLogs: [{
      FlowLogId: "fl-0acme0prod0flow001", ResourceId: P.vpc, LogDestinationType: "cloud-watch-logs", LogGroupName: NETWORK.flowLogGroup,
      LogDestination: `arn:aws:logs:${REGION}:${ACCT}:log-group:${NETWORK.flowLogGroup}`, TrafficType: "ALL", FlowLogStatus: "ACTIVE", DeliverLogsStatus: "SUCCESS",
    }],
    nacls: [
      { NetworkAclId: "acl-0acme0prod0default", VpcId: P.vpc, OwnerId: ACCT, IsDefault: true, Entries: OPEN, Associations: P.publicSubnets.map((SubnetId) => ({ SubnetId })) },
      {
        // The private subnets only take return traffic from the internet (ephemeral ports) and anything from inside.
        NetworkAclId: "acl-0acme0prod0private", VpcId: P.vpc, OwnerId: ACCT, IsDefault: false, Tags: tags({ Name: `${P.name}-private` }),
        Entries: [rule(100, "allow", { Protocol: "6", PortRange: { From: 1024, To: 65535 } }), rule(110, "allow", { CidrBlock: "10.0.0.0/8" }), rule(32767, "deny"), rule(100, "allow", { Egress: true }), rule(32767, "deny", { Egress: true })],
        Associations: P.privateSubnets.map((SubnetId) => ({ SubnetId })),
      },
      { NetworkAclId: "acl-0acme0stg0default", VpcId: S.vpc, OwnerId: ACCT, IsDefault: true, Entries: OPEN, Associations: [...S.publicSubnets, ...S.namedPrivateSubnets].map((SubnetId) => ({ SubnetId })) },
    ],
    vpns: [{
      VpnConnectionId: NETWORK.vpn.id, State: "available", Type: "ipsec.1", Category: "VPN", CustomerGatewayId: "cgw-0acme0office0001", VpnGatewayId: VGW, Tags: tags({ Name: NETWORK.vpn.name }),
      VgwTelemetry: NETWORK.vpn.tunnels.map((Status, i) => ({ OutsideIpAddress: `198.51.100.${21 + i}`, Status, StatusMessage: Status === "DOWN" ? "IPSEC IS DOWN" : "", LastStatusChange: "2026-10-05T06:40:00.000Z" })),
    }],
  };
}

function eu(): VpcRaw {
  const V = EU.vpc;
  return {
    vpcs: [{ VpcId: V.id, OwnerId: ACCT, CidrBlock: V.cidr, CidrBlockAssociationSet: [{ CidrBlock: V.cidr, CidrBlockState: { State: "associated" } }], State: "available", IsDefault: false, DhcpOptionsId: "dopt-0acme0eu0default", InstanceTenancy: "default", Tags: tags({ Name: "acme-production-eu" }) }],
    subnets: V.subnets.map((id, i) => subnet(id, V.id, `10.40.${10 + i}.0/24`, `${EU_REGION}${"ab"[i]}`, `acme-production-eu-private-${"ab"[i]}`, 246 + i, false)),
    routeTables: [{ RouteTableId: "rtb-0acme0eu0prod0main", VpcId: V.id, OwnerId: ACCT, Associations: [{ Main: true }], Routes: [local(V.cidr)] }],
    natGateways: [], internetGateways: [], egressOnly: [], endpoints: [], peerings: [], tgwAttachments: [], addresses: [], flowLogs: [], vpns: [],
    nacls: [{ NetworkAclId: "acl-0acme0eu0default", VpcId: V.id, OwnerId: ACCT, IsDefault: true, Entries: OPEN, Associations: V.subnets.map((SubnetId) => ({ SubnetId })) }],
  };
}

export function simNetwork(region: string): VpcRaw {
  if (region === REGION) return home();
  if (region === EU_REGION) return eu();
  return { vpcs: [], subnets: [], routeTables: [], natGateways: [], internetGateways: [], egressOnly: [], endpoints: [], peerings: [], tgwAttachments: [], addresses: [], flowLogs: [], nacls: [], vpns: [] };
}
