import { test } from "node:test";
import assert from "node:assert/strict";
import { propagate } from "./propagate.ts";
import { securityGroupResults } from "./security-group.ts";
import { classify, effectiveTable, lowOnIps, naclOpen, subnetDetail, vpcDetail, vpcResults, vpnHealth, vpnView, type RawNaclEntry, type RawVpn, type VpcRaw } from "./vpc.ts";
import type { Resource } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_77aa";
const a = (type: string, id: string) => `arn:aws:ec2:${R}:${ACCT}:${type}/${id}`;
const tag = (Name: string, more: Record<string, string> = {}) => Object.entries({ Name, ...more }).map(([Key, Value]) => ({ Key, Value }));
const allowAll = (n: number, egress: boolean): RawNaclEntry => ({ RuleNumber: n, Egress: egress, Protocol: "-1", RuleAction: "allow", CidrBlock: "0.0.0.0/0" });
const denyAll = (egress: boolean): RawNaclEntry => ({ RuleNumber: 32767, Egress: egress, Protocol: "-1", RuleAction: "deny", CidrBlock: "0.0.0.0/0" });

// The real pattern behind F04 and the private-a/b warnings, anonymised: a production VPC whose "private" subnets share
// the public route table's default route to the internet gateway, peered with the default VPC; an S3 gateway endpoint;
// load-balancer and database Elastic IPs managed by AWS and one on an instance; default network ACLs.
const raw: VpcRaw = {
  vpcs: [
    { VpcId: "vpc-prod", OwnerId: ACCT, CidrBlock: "10.20.0.0/16", CidrBlockAssociationSet: [{ CidrBlock: "10.20.0.0/16", CidrBlockState: { State: "associated" } }], State: "available", IsDefault: false, DhcpOptionsId: "dopt-1", InstanceTenancy: "default", Tags: tag("acme-production") },
    { VpcId: "vpc-default", OwnerId: ACCT, CidrBlock: "172.31.0.0/16", State: "available", IsDefault: true, DhcpOptionsId: "dopt-1" },
  ],
  subnets: [
    { SubnetId: "subnet-pub-a", VpcId: "vpc-prod", OwnerId: ACCT, CidrBlock: "10.20.0.0/24", AvailabilityZone: "us-east-1a", AvailableIpAddressCount: 248, MapPublicIpOnLaunch: true, State: "available", Tags: tag("acme-production-public-a") },
    { SubnetId: "subnet-priv-a", VpcId: "vpc-prod", OwnerId: ACCT, CidrBlock: "10.20.10.0/24", AvailabilityZone: "us-east-1a", AvailableIpAddressCount: 250, MapPublicIpOnLaunch: false, State: "available", Tags: tag("acme-production-private-a") },
    { SubnetId: "subnet-priv-b", VpcId: "vpc-prod", OwnerId: ACCT, CidrBlock: "10.20.11.0/24", AvailabilityZone: "us-east-1b", AvailableIpAddressCount: 7, MapPublicIpOnLaunch: false, State: "available", Tags: tag("acme-production-private-b") },
    { SubnetId: "subnet-def-a", VpcId: "vpc-default", OwnerId: ACCT, CidrBlock: "172.31.0.0/20", AvailabilityZone: "us-east-1a", AvailableIpAddressCount: 4091, MapPublicIpOnLaunch: true, DefaultForAz: true, State: "available" },
  ],
  routeTables: [
    {
      RouteTableId: "rtb-public", VpcId: "vpc-prod", OwnerId: ACCT, Associations: [{ SubnetId: "subnet-pub-a" }],
      Routes: [
        { DestinationCidrBlock: "172.31.0.0/16", VpcPeeringConnectionId: "pcx-1", State: "active" }, { DestinationCidrBlock: "10.20.0.0/16", GatewayId: "local", State: "active" },
        { DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-prod", State: "active" }, { DestinationPrefixListId: "pl-s3", GatewayId: "vpce-s3", State: "active" },
      ],
    },
    { RouteTableId: "rtb-main", VpcId: "vpc-prod", OwnerId: ACCT, Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: "10.20.0.0/16", GatewayId: "local", State: "active" }] },
    {
      RouteTableId: "rtb-private", VpcId: "vpc-prod", OwnerId: ACCT, Associations: [{ SubnetId: "subnet-priv-a" }, { SubnetId: "subnet-priv-b" }],
      Routes: [
        { DestinationCidrBlock: "172.31.0.0/16", VpcPeeringConnectionId: "pcx-1", State: "active" }, { DestinationCidrBlock: "10.20.0.0/16", GatewayId: "local", State: "active" },
        { DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-prod", State: "active" }, { DestinationPrefixListId: "pl-s3", GatewayId: "vpce-s3", State: "active" },
      ],
    },
    {
      RouteTableId: "rtb-default", VpcId: "vpc-default", OwnerId: ACCT, Associations: [{ Main: true }],
      Routes: [{ DestinationCidrBlock: "172.31.0.0/16", GatewayId: "local", State: "active" }, { DestinationCidrBlock: "10.20.0.0/16", VpcPeeringConnectionId: "pcx-1", State: "active" }, { DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-default", State: "active" }],
    },
  ],
  natGateways: [],
  internetGateways: [
    { InternetGatewayId: "igw-prod", OwnerId: ACCT, Attachments: [{ State: "available", VpcId: "vpc-prod" }], Tags: tag("acme-production-igw") },
    { InternetGatewayId: "igw-default", OwnerId: ACCT, Attachments: [{ State: "available", VpcId: "vpc-default" }] },
  ],
  egressOnly: [],
  endpoints: [{ VpcEndpointId: "vpce-s3", VpcEndpointType: "Gateway", VpcId: "vpc-prod", ServiceName: "com.amazonaws.us-east-1.s3", State: "available", RouteTableIds: ["rtb-public", "rtb-private"], SubnetIds: [], Groups: [], DnsEntries: [], OwnerId: ACCT, Tags: tag("acme-production-s3") }],
  peerings: [{
    VpcPeeringConnectionId: "pcx-1", Status: { Code: "active", Message: "Active" }, Tags: tag("production-to-default"),
    RequesterVpcInfo: { VpcId: "vpc-prod", OwnerId: ACCT, Region: R, CidrBlock: "10.20.0.0/16" }, AccepterVpcInfo: { VpcId: "vpc-default", OwnerId: ACCT, Region: R, CidrBlock: "172.31.0.0/16" },
  }],
  tgwAttachments: [],
  addresses: [
    { AllocationId: "eipalloc-alb", AssociationId: "eipassoc-1", PublicIp: "203.0.113.10", NetworkInterfaceId: "eni-alb", Domain: "vpc", ServiceManaged: "alb" },
    { AllocationId: "eipalloc-rds", AssociationId: "eipassoc-2", PublicIp: "203.0.113.11", NetworkInterfaceId: "eni-rds", Domain: "vpc", ServiceManaged: "rds" },
    { AllocationId: "eipalloc-box", AssociationId: "eipassoc-3", PublicIp: "203.0.113.12", InstanceId: "i-0box", NetworkInterfaceId: "eni-box", Domain: "vpc", Tags: tag("acme-staging") },
  ],
  flowLogs: [],
  nacls: [
    { NetworkAclId: "acl-prod", VpcId: "vpc-prod", OwnerId: ACCT, IsDefault: true, Entries: [allowAll(100, true), denyAll(true), allowAll(100, false), denyAll(false)], Associations: [{ SubnetId: "subnet-pub-a" }, { SubnetId: "subnet-priv-a" }, { SubnetId: "subnet-priv-b" }] },
    { NetworkAclId: "acl-default", VpcId: "vpc-default", OwnerId: ACCT, IsDefault: true, Entries: [allowAll(100, false), denyAll(false)], Associations: [{ SubnetId: "subnet-def-a" }] },
  ],
  vpns: [],
};

const by = (res: Resource[], key: string) => res.find((r) => r.key === key)!;

test("golden: subnets classified by their route table; the private ones that route to the internet gateway warn", () => {
  const out = vpcResults(raw, { region: R, accountId: ACCT, now: NOW });
  const priv = by(out.resources, a("subnet", "subnet-priv-a"));
  assert.deepEqual(priv, {
    key: a("subnet", "subnet-priv-a"), kind: "subnet", provider: "vpc", name: "acme-production-private-a", region: R, tags: { Name: "acme-production-private-a" },
    health: "warning", healthReason: "named private but routes 0.0.0.0/0 to igw-prod",
    props: [
      { label: "Subnet id", value: "subnet-priv-a", mono: true }, { label: "CIDR", value: "10.20.10.0/24", mono: true }, { label: "Availability zone", value: "us-east-1a" },
      { label: "Class", value: "Public — 0.0.0.0/0 → igw-prod" }, { label: "Route table", value: "rtb-private", mono: true },
      { label: "Other routes", value: "172.31.0.0/16 → pcx-1" }, { label: "Gateway endpoints", value: "pl-s3 → vpce-s3" },
      { label: "Network ACL", value: "acl-prod (default) — from the internet: all" }, { label: "Free IP addresses", value: "250" }, { label: "Public IP on launch", value: "no" },
    ],
    aliases: ["subnet-priv-a"], vpcId: "vpc-prod", parent: a("vpc", "vpc-prod"),
    consoleUrl: `https://${R}.console.aws.amazon.com/vpcconsole/home?region=${R}#SubnetDetails:subnetId=subnet-priv-a`,
    facts: { routesToIgw: true, naclOpen: ["all"] }, observedAt: NOW,
  });
  const b = by(out.resources, a("subnet", "subnet-priv-b"));
  assert.equal(b.healthReason, "named private but routes 0.0.0.0/0 to igw-prod · only 7 free IP addresses left");
  const pub = by(out.resources, a("subnet", "subnet-pub-a"));
  assert.deepEqual([pub.health, pub.facts?.routesToIgw], ["ok", true], "public and named so: fine");
  assert.equal(by(out.resources, a("subnet", "subnet-def-a")).props.find((p) => p.label === "Default subnet")?.value, "yes");

  const vpc = by(out.resources, a("vpc", "vpc-prod"));
  assert.deepEqual(vpc.facts, { cidrs: ["10.20.0.0/16"] });
  assert.equal(vpc.props.find((p) => p.label === "Subnets")?.value, "3 — 3 public");
  assert.ok(vpc.aliases!.includes("rtb-private") && vpc.aliases!.includes(a("route-table", "rtb-private")) && vpc.aliases!.includes(a("network-acl", "acl-prod")), "route tables and ACLs fold into their VPC");
  assert.equal(by(out.resources, a("vpc", "vpc-default")).props.find((p) => p.label === "Default VPC")?.value, "yes");

  // Peering: one node, linked to both VPCs; the gateway endpoint ok; the internet gateways in their VPCs.
  const pcx = out.links.filter((l) => l.from === a("vpc-peering-connection", "pcx-1")).map((l) => [l.to, l.kind, l.label]);
  assert.deepEqual(pcx, [[a("vpc", "vpc-prod"), "route", "peering"], [a("vpc", "vpc-default"), "route", "peering"]]);
  assert.match(out.links[out.links.length - 1].evidence, /route table rtb-default in vpc-default sends 10\.20\.0\.0\/16 here/);
  const ep = by(out.resources, a("vpc-endpoint", "vpce-s3"));
  assert.deepEqual([ep.health, ep.name, ep.parent], ["ok", "acme-production-s3", a("vpc", "vpc-prod")]);
  assert.deepEqual(by(out.resources, a("internet-gateway", "igw-prod")).parent, a("vpc", "vpc-prod"));

  // Elastic IPs: service-managed and associated ones are hidden rows, never nodes; none here is billed for nothing.
  const eips = out.resources.filter((r) => r.kind === "elastic-ip");
  assert.deepEqual(eips.map((e) => [e.name, e.hidden, e.health]), [["203.0.113.10", true, "ok"], ["203.0.113.11", true, "ok"], ["acme-staging", true, "ok"]]);
  assert.equal(eips[2].parent, "ec2:i-0box");
  assert.deepEqual(out.resources.filter((r) => !r.hidden).map((r) => r.kind).sort(), ["internet-gateway", "internet-gateway", "subnet", "subnet", "subnet", "subnet", "vpc", "vpc", "vpc-endpoint", "vpc-peering"]);
});

test("R4 end to end: the public database in a 'private' subnet routed to the internet, its group open on 5432 → an error and an internet edge; the peered /16 → an allowed edge", () => {
  const net = vpcResults(raw, { region: R, accountId: ACCT, now: NOW });
  const sg = securityGroupResults({
    groups: [{ GroupId: "sg-db", GroupName: "acme-production-db", VpcId: "vpc-prod", OwnerId: ACCT }], region: R, accountId: ACCT,
    rules: [
      { GroupId: "sg-db", IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "0.0.0.0/0" },
      { GroupId: "sg-db", IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "172.31.0.0/16" },
    ],
    enis: [],
  });
  const db: Resource = {
    key: "rds:acme-production-pg", kind: "rds", provider: "rds", name: "acme-production-pg", region: R, tags: {}, health: "ok", props: [],
    vpcId: "vpc-prod", subnetIds: ["subnet-priv-a", "subnet-priv-b"], securityGroups: ["sg-db"], facts: { public: true },
  };
  const out = propagate({ resources: [...net.resources, ...sg.resources, db], edges: net.links.map((l) => ({ id: `${l.from}->${l.to}:${l.kind}`, from: l.from, to: l.to, kind: l.kind, label: l.label, evidence: [l.evidence], confidence: "config" as const })), now: NOW });
  const after = out.resources.find((r) => r.key === db.key)!;
  assert.equal(after.health, "error");
  assert.match(after.healthReason!, /reachable from the internet on 5432\/tcp \(sg-db allows 0\.0\.0\.0\/0\)/);
  assert.ok(out.edges.some((e) => e.from === "external:internet" && e.to === db.key));
  const peered = out.edges.find((e) => e.from === a("vpc", "vpc-default") && e.to === db.key);
  assert.equal(peered?.label, "5432/tcp via pcx-1");

  // An ACL that only lets HTTPS in keeps the same database unreachable: a warning, no internet edge.
  const strict = vpcResults({ ...raw, nacls: [{ ...raw.nacls![0], Entries: [{ RuleNumber: 100, Protocol: "6", RuleAction: "allow", CidrBlock: "0.0.0.0/0", PortRange: { From: 443, To: 443 } }, denyAll(false)] }] }, { region: R, accountId: ACCT });
  const out2 = propagate({ resources: [...strict.resources, ...sg.resources, db], edges: [], now: NOW });
  assert.equal(out2.resources.find((r) => r.key === db.key)!.health, "warning");
  assert.ok(!out2.edges.some((e) => e.from === "external:internet"));
});

test("subnet classes: NAT, transit gateway, virtual private gateway, interface, Gateway Load Balancer endpoint, IPv6 egress-only, isolated, blackhole", () => {
  const c = (routes: Parameters<typeof classify>[0]) => [classify(routes).class, classify(routes).target, classify(routes).routesToIgw];
  assert.deepEqual(c([{ DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: "nat-1" }]), ["private-nat", "nat-1", false]);
  assert.deepEqual(c([{ DestinationCidrBlock: "0.0.0.0/0", TransitGatewayId: "tgw-1" }]), ["private-routed", "tgw-1", false]);
  assert.deepEqual(c([{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "vgw-1" }]), ["private-routed", "vgw-1", false]);
  assert.deepEqual(c([{ DestinationCidrBlock: "0.0.0.0/0", NetworkInterfaceId: "eni-1" }]), ["private-routed", "eni-1", false]);
  assert.deepEqual(c([{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "vpce-gwlb" }]), ["private-routed", "vpce-gwlb", false]);
  assert.deepEqual(c([{ DestinationIpv6CidrBlock: "::/0", EgressOnlyInternetGatewayId: "eigw-1" }]), ["ipv6-egress-only", "eigw-1", false]);
  assert.deepEqual(c([{ DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: "nat-1" }, { DestinationIpv6CidrBlock: "::/0", GatewayId: "igw-1" }]), ["public", "igw-1", true], "IPv6 to the internet gateway is public");
  assert.deepEqual(c([{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-1", State: "blackhole" }]), ["isolated", undefined, false]);
  assert.deepEqual(c([{ DestinationCidrBlock: "10.0.0.0/16", GatewayId: "local" }]), ["isolated", undefined, false]);
  assert.equal(effectiveTable({ SubnetId: "subnet-x", VpcId: "vpc-prod" }, raw.routeTables!).table?.RouteTableId, "rtb-main", "no explicit association: the main table");
});

test("network ACLs in rule-number order, IPv4 and IPv6, the first matching rule decides", () => {
  assert.deepEqual(naclOpen([allowAll(100, false), denyAll(false)]), ["all"]);
  assert.deepEqual(naclOpen([denyAll(false)]), []);
  assert.deepEqual(naclOpen([
    { RuleNumber: 90, Protocol: "6", RuleAction: "deny", CidrBlock: "0.0.0.0/0", PortRange: { From: 5432, To: 5432 } },
    allowAll(100, false), denyAll(false),
  ]), ["0-5431/tcp", "5433-65535/tcp", "0-65535/udp"]);
  assert.deepEqual(naclOpen([
    { RuleNumber: 100, Protocol: "6", RuleAction: "allow", CidrBlock: "0.0.0.0/0", PortRange: { From: 443, To: 443 } },
    { RuleNumber: 110, Protocol: "6", RuleAction: "allow", CidrBlock: "10.0.0.0/8", PortRange: { From: 5432, To: 5432 } },
    { RuleNumber: 120, Protocol: "6", RuleAction: "allow", Ipv6CidrBlock: "::/0", PortRange: { From: 80, To: 80 } },
    { RuleNumber: 130, Protocol: "-1", RuleAction: "allow", CidrBlock: "0.0.0.0/0", Egress: true },
    denyAll(false),
  ]), ["80/tcp", "443/tcp"], "a narrower CIDR and outbound rules say nothing about the internet");
});

test("NAT, transit gateway, VPN, endpoints, egress-only gateways, flow logs, unattached Elastic IPs; states compared lower-cased", () => {
  const out = vpcResults({
    vpcs: [{ VpcId: "vpc-1", OwnerId: ACCT, CidrBlock: "10.0.0.0/16", State: "available", Tags: tag("one") }],
    subnets: [
      { SubnetId: "subnet-nat", VpcId: "vpc-1", OwnerId: ACCT, CidrBlock: "10.0.1.0/24", AvailableIpAddressCount: 200, Tags: tag("app-a") },
      { SubnetId: "subnet-tgw", VpcId: "vpc-1", OwnerId: ACCT, CidrBlock: "10.0.2.0/24", AvailableIpAddressCount: 200 },
      { SubnetId: "subnet-vpn", VpcId: "vpc-1", OwnerId: ACCT, CidrBlock: "10.0.3.0/28", AvailableIpAddressCount: 5 },
    ],
    routeTables: [
      { RouteTableId: "rtb-nat", VpcId: "vpc-1", Associations: [{ SubnetId: "subnet-nat" }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: "nat-1" }] },
      { RouteTableId: "rtb-tgw", VpcId: "vpc-1", Associations: [{ SubnetId: "subnet-tgw" }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", TransitGatewayId: "tgw-1" }] },
      { RouteTableId: "rtb-vpn", VpcId: "vpc-1", Associations: [{ SubnetId: "subnet-vpn" }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "vgw-1" }], PropagatingVgws: [{ GatewayId: "vgw-1" }] },
    ],
    natGateways: [
      { NatGatewayId: "nat-1", SubnetId: "subnet-nat", VpcId: "vpc-1", State: "available", ConnectivityType: "public", NatGatewayAddresses: [{ AllocationId: "eipalloc-nat", PublicIp: "198.51.100.1", PrivateIp: "10.0.1.9", NetworkInterfaceId: "eni-nat" }] },
      { NatGatewayId: "nat-old", SubnetId: "subnet-nat", VpcId: "vpc-1", State: "deleted" },
      { NatGatewayId: "nat-bad", SubnetId: "subnet-nat", VpcId: "vpc-1", State: "failed", FailureMessage: "Elastic IP already associated" },
    ],
    internetGateways: [{ InternetGatewayId: "igw-loose", OwnerId: ACCT, Attachments: [] }],
    egressOnly: [{ EgressOnlyInternetGatewayId: "eigw-1", Attachments: [{ State: "attached", VpcId: "vpc-1" }] }],
    endpoints: [
      { VpcEndpointId: "vpce-ecr", VpcEndpointType: "Interface", VpcId: "vpc-1", ServiceName: "com.amazonaws.us-east-1.ecr.dkr", State: "Partial", SubnetIds: ["subnet-nat"], Groups: [{ GroupId: "sg-ep" }], PrivateDnsEnabled: true, DnsEntries: [{ DnsName: "vpce-ecr-abc.dkr.ecr.us-east-1.vpce.amazonaws.com" }, { DnsName: "*.dkr.ecr.us-east-1.amazonaws.com" }] },
      { VpcEndpointId: "vpce-gone", VpcEndpointType: "Gateway", VpcId: "vpc-1", State: "Deleted" },
      { VpcEndpointId: "vpce-x", VpcEndpointType: "Interface", VpcId: "vpc-1", State: "Rejected", LastError: { Message: "not allowed" } },
    ],
    peerings: [{ VpcPeeringConnectionId: "pcx-x", Status: { Code: "pending-acceptance", Message: "Pending Acceptance by 210987654321" }, RequesterVpcInfo: { VpcId: "vpc-1", OwnerId: ACCT, Region: R }, AccepterVpcInfo: { VpcId: "vpc-other", OwnerId: "210987654321", Region: "eu-west-1", CidrBlock: "10.9.0.0/16" } }],
    tgwAttachments: [{ TransitGatewayAttachmentId: "tgw-attach-1", TransitGatewayId: "tgw-1", ResourceType: "vpc", ResourceId: "vpc-1", ResourceOwnerId: ACCT, State: "pendingAcceptance" }],
    addresses: [
      { AllocationId: "eipalloc-nat", AssociationId: "eipassoc-n", PublicIp: "198.51.100.1", NetworkInterfaceId: "eni-nat" },
      { AllocationId: "eipalloc-loose", PublicIp: "198.51.100.2", Tags: tag("old-ip") },
    ],
    flowLogs: [
      { FlowLogId: "fl-1", ResourceId: "vpc-1", LogDestinationType: "cloud-watch-logs", LogGroupName: "/acme/flow", TrafficType: "ALL", FlowLogStatus: "ACTIVE", DeliverLogsStatus: "SUCCESS" },
      { FlowLogId: "fl-2", ResourceId: "subnet-tgw", LogDestinationType: "s3", LogDestination: "arn:aws:s3:::acme-logs/flow/", TrafficType: "REJECT", DeliverLogsStatus: "FAILED" },
    ],
    nacls: undefined,
    vpns: [{ VpnConnectionId: "vpn-1", State: "available", Type: "ipsec.1", VpnGatewayId: "vgw-1", CustomerGatewayId: "cgw-1", VgwTelemetry: [{ OutsideIpAddress: "192.0.2.1", Status: "UP" }, { OutsideIpAddress: "192.0.2.2", Status: "DOWN" }], Tags: tag("office") }],
  }, { region: R, accountId: ACCT, home: R });
  const r = (type: string, id: string) => by(out.resources, a(type, id));
  assert.deepEqual([r("natgateway", "nat-1").health, r("natgateway", "nat-1").parent, r("natgateway", "nat-1").aliases], ["ok", a("subnet", "subnet-nat"), ["nat-1", "eipalloc-nat", a("elastic-ip", "eipalloc-nat")]]);
  assert.equal(out.resources.find((x) => x.key.endsWith("nat-old")), undefined, "deleted NAT gateways are gone");
  assert.deepEqual([r("natgateway", "nat-bad").health, r("natgateway", "nat-bad").healthReason], ["error", "failed: Elastic IP already associated"]);
  assert.deepEqual([r("internet-gateway", "igw-loose").health, r("internet-gateway", "igw-loose").healthReason], ["warning", "not attached to a VPC"]);
  assert.deepEqual([r("egress-only-internet-gateway", "eigw-1").kind, r("egress-only-internet-gateway", "eigw-1").parent], ["internet-gateway", a("vpc", "vpc-1")]);
  const ecr = r("vpc-endpoint", "vpce-ecr");
  assert.deepEqual([ecr.health, ecr.healthReason, ecr.name, ecr.endpoints, ecr.securityGroups], ["warning", "partially available", "ecr.dkr (interface)", ["vpce-ecr-abc.dkr.ecr.us-east-1.vpce.amazonaws.com", "dkr.ecr.us-east-1.amazonaws.com"], ["sg-ep"]]);
  assert.equal(out.resources.find((x) => x.key.endsWith("vpce-gone")), undefined);
  assert.deepEqual([r("vpc-endpoint", "vpce-x").health, r("vpc-endpoint", "vpce-x").healthReason], ["error", "rejected: not allowed"]);
  assert.deepEqual([r("vpc-peering-connection", "pcx-x").health, r("vpc-peering-connection", "pcx-x").healthReason], ["warning", "Pending Acceptance by 210987654321"]);
  assert.ok(out.links.some((l) => l.from === a("vpc-peering-connection", "pcx-x") && l.to === "arn:aws:ec2:eu-west-1:210987654321:vpc/vpc-other"), "the other side, in its own account and region");
  assert.deepEqual([r("transit-gateway-attachment", "tgw-attach-1").health, r("transit-gateway-attachment", "tgw-attach-1").healthReason], ["warning", "pendingacceptance"]);
  const vpn = r("vpn-connection", "vpn-1");
  assert.deepEqual([vpn.health, vpn.healthReason, vpn.vpcId], ["warning", "1 of 2 tunnels down", "vpc-1"]);
  const loose = r("elastic-ip", "eipalloc-loose");
  assert.deepEqual([loose.health, loose.healthReason, loose.hidden, loose.endpoints, loose.name], ["warning", "not attached — billed hourly", undefined, ["198.51.100.2"], "old-ip"]);
  assert.equal(out.resources.filter((x) => x.kind === "elastic-ip").length, 1, "the NAT gateway's address is its alias, not a row");
  // Default routes become links to the node that carries them.
  const route = (s: string) => out.links.find((l) => l.from === a("subnet", s) && l.kind === "route");
  assert.deepEqual([route("subnet-nat")?.to, route("subnet-tgw")?.to, route("subnet-vpn")?.to], [a("natgateway", "nat-1"), a("transit-gateway-attachment", "tgw-attach-1"), a("vpn-connection", "vpn-1")]);
  assert.equal(r("subnet", "subnet-vpn").healthReason, "only 5 free IP addresses left");
  assert.equal(r("subnet", "subnet-nat").facts?.naclOpen, undefined, "ACLs not read: no naclOpen (R4 counts it as open)");
  assert.equal(r("subnet", "subnet-nat").facts?.routesToIgw, false);
  // Flow logs → their destination; a failing delivery warns the VPC.
  assert.deepEqual(out.links.filter((l) => l.kind === "logs").map((l) => [l.from, l.to, l.label]), [
    [a("vpc", "vpc-1"), `arn:aws:logs:${R}:${ACCT}:log-group:/acme/flow`, "flow logs (all)"], [a("subnet", "subnet-tgw"), "arn:aws:s3:::acme-logs", "flow logs (reject)"],
  ]);
  assert.equal(r("vpc", "vpc-1").health, "ok");
  assert.match(vpcResults({ vpcs: [{ VpcId: "vpc-1", OwnerId: ACCT }], flowLogs: [{ FlowLogId: "fl-9", ResourceId: "vpc-1", DeliverLogsStatus: "FAILED", LogGroupName: "/x" }] }, { region: R, accountId: ACCT }).resources[0].healthReason!, /flow log delivery failing \(fl-9\)/);
});

test("VPN tunnels: all up ok, all down error; pre-shared keys never leave the API answer", () => {
  const tunnels = (...s: string[]) => ({ State: "available", VgwTelemetry: s.map((Status) => ({ Status })) });
  assert.deepEqual(vpnHealth(tunnels("UP", "UP")), { health: "ok" });
  assert.deepEqual(vpnHealth(tunnels("DOWN", "DOWN")), { health: "error", healthReason: "all 2 tunnels down" });
  assert.deepEqual(vpnHealth({ State: "pending" }), { health: "warning", healthReason: "pending" });
  const withSecrets = {
    VpnConnectionId: "vpn-s", State: "available", VpnGatewayId: "vgw-9", VgwTelemetry: [{ Status: "UP", OutsideIpAddress: "192.0.2.9" }],
    CustomerGatewayConfiguration: `<vpn_connection><pre_shared_key>${SENTINEL}</pre_shared_key></vpn_connection>`,
    Options: { TunnelOptions: [{ PreSharedKey: SENTINEL, OutsideIpAddress: "192.0.2.9" }] }, PreSharedKeyArn: `arn:aws:secretsmanager:${R}:${ACCT}:secret:${SENTINEL}`,
  } as RawVpn;
  assert.ok(!JSON.stringify(vpnView(withSecrets)).includes(SENTINEL));
  const out = vpcResults({ vpcs: [], vpns: [withSecrets] }, { region: R, accountId: ACCT });
  assert.equal(out.resources.length, 1);
  assert.ok(!JSON.stringify(out).includes(SENTINEL), "no pre-shared key, configuration or key ARN in the output");
});

test("free addresses: below max(8, 5 % of the range) warns", () => {
  assert.equal(lowOnIps("10.0.0.0/24", 13), false, "5 % of 256 is 12.8");
  assert.equal(lowOnIps("10.0.0.0/24", 12), true);
  assert.equal(lowOnIps("10.0.0.0/28", 8), false, "small subnets: at least 8");
  assert.equal(lowOnIps("10.0.0.0/28", 7), true);
  assert.equal(lowOnIps("10.0.0.0/20", 200), true, "5 % of 4,096 is 204.8");
  assert.equal(lowOnIps(undefined, 1), false);
});

test("panels: the VPC's subnets, route tables, ACLs, gateways and peerings; a subnet's routes and ACL rules", () => {
  const d = vpcDetail(a("vpc", "vpc-prod"), "vpc-prod", raw);
  assert.deepEqual(d.sections.map((s) => s.title), ["Subnets", "Route tables", "Network ACLs", "Gateways and endpoints", "Peerings, transit gateways and VPNs", "Flow logs"]);
  assert.deepEqual(d.sections[0].table!.rows.map((r) => [r[1], r[4]]), [["subnet-pub-a", "Public — 0.0.0.0/0 → igw-prod"], ["subnet-priv-a", "Public — 0.0.0.0/0 → igw-prod"], ["subnet-priv-b", "Public — 0.0.0.0/0 → igw-prod"]]);
  assert.deepEqual(d.sections[1].table!.rows.find((r) => r[0] === "rtb-private"), ["rtb-private", "", "subnet-priv-a, subnet-priv-b", "172.31.0.0/16 → pcx-1; 0.0.0.0/0 → igw-prod; pl-s3 → vpce-s3"]);
  assert.deepEqual(d.sections[4].table!.rows, [["Peering", "pcx-1", "vpc-default (172.31.0.0/16)", "active"]]);
  assert.equal(d.sections[5].note, "No flow logs: traffic in this VPC isn't recorded.");
  const s = subnetDetail(a("subnet", "subnet-priv-b"), "subnet-priv-b", raw);
  assert.deepEqual(s.sections.map((x) => x.title), ["Routes (rtb-private)", "Network ACL acl-prod (default) — inbound"]);
  assert.deepEqual(s.sections[1].table!.rows, [["100", "all", "all", "0.0.0.0/0", "allow"], ["*", "all", "all", "0.0.0.0/0", "deny"]]);
});

// The simulated account (the demo): the four network providers run against it in a child process (they import
// "server-only", which resolves only under the react-server condition), then the exposure rule over what they found.
const scenario = `
const load = (f) => import(new URL("../server/providers/" + f, ${JSON.stringify(import.meta.url)}).href);
const ps = [(await load("vpc.ts")).vpcProvider, (await load("security-group.ts")).securityGroupProvider, (await load("cloudmap.ts")).cloudmapProvider, (await load("ebs.ts")).ebsProvider];
const out = {};
for (const region of ["us-east-1", "eu-west-1", "ap-south-1"]) {
  const notes = [], checkpoints = [];
  const ctx = { region, home: "us-east-1", accountId: "123456789012", mock: true, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r) };
  for (const p of ps) {
    const r = await p.discover(ctx);
    out[p.id + "@" + region] = { resources: r.resources, links: r.links, sgRules: r.sgRules ?? [], notes, multi: p.multiRegionMock, activity: r.resources.map((x) => (p.activity ? p.activity(x) : []).length) };
  }
}
console.log(JSON.stringify(out));
`;

test("the simulated account: staging's 'private' subnets and its open database group, production's NAT, Cloud Map and EBS — and R4 turns them into an exposure error", async () => {
  const { execFileSync } = await import("node:child_process");
  const o = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
    encoding: "utf8", env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:" }, timeout: 60_000,
  }).trim().split("\n").pop()!) as Record<string, { resources: Resource[]; links: { from: string; to: string; kind: string }[]; sgRules: unknown[]; notes: string[]; multi: boolean; activity: number[] }>;
  const res = (k: string) => o[k].resources;
  const named = (k: string, name: string) => res(k).find((r) => r.name === name)!;
  assert.ok(Object.values(o).every((x) => x.multi && !x.notes.length), "every provider answers per region, without notes");
  assert.deepEqual(["vpc", "security-group", "cloudmap", "ebs"].map((p) => res(`${p}@ap-south-1`).length), [0, 0, 0, 0], "other regions are empty");
  assert.deepEqual(res("vpc@eu-west-1").map((r) => r.kind).sort(), ["subnet", "subnet", "vpc"]);
  assert.deepEqual(res("security-group@eu-west-1").map((r) => r.aliases?.[0]).sort(), ["sg-eu-api", "sg-eu-db", "sg-eu-worker"]);

  const stgPrivate = named("vpc@us-east-1", "acme-staging-private-a");
  assert.deepEqual([stgPrivate.health, stgPrivate.healthReason, stgPrivate.facts], ["warning", "named private but routes 0.0.0.0/0 to igw-stg", { routesToIgw: true, naclOpen: ["all"] }]);
  assert.deepEqual(named("vpc@us-east-1", "acme-production-private-a").facts, { routesToIgw: false, naclOpen: ["1024-65535/tcp"] });
  assert.deepEqual([named("vpc@us-east-1", "acme-office").health, named("vpc@us-east-1", "acme-old-ip").healthReason], ["warning", "not attached — billed hourly"]);
  assert.ok(o["vpc@us-east-1"].activity.some((n) => n === 1), "the NAT gateway declares its activity");

  const db = named("security-group@us-east-1", "staging-db");
  assert.deepEqual([db.health, db.healthReason, db.facts?.openIngress], ["warning", "open to the internet on 5432/tcp", ["5432/tcp"]]);
  assert.equal(o["security-group@us-east-1"].sgRules.length, res("security-group@us-east-1").length, "every group's rules go out for the allowed edges (CC-19)");
  assert.deepEqual([named("security-group@us-east-1", "old-bastion").facts?.attachments, named("security-group@us-east-1", "old-bastion").facts?.referencedBy], [0, 0]);
  assert.ok((named("security-group@us-east-1", "storefront-api").facts?.attachments as number) > 0, "running tasks use the api group");

  assert.deepEqual(res("cloudmap@us-east-1").map((r) => [r.name, r.health]), [["acme.internal", "ok"], ["api.acme.internal", "ok"], ["worker.acme.internal", "ok"], ["billing.acme.internal", "stopped"]]);
  assert.ok(o["cloudmap@us-east-1"].links.some((l) => l.to === "ecs:service/acme-production/api" && l.kind === "route"));
  assert.deepEqual(res("ebs@us-east-1").map((r) => [r.name, r.health, r.parent]), [["acme-staging-root", "ok", "ec2:i-0a1b2c3d4e5f67890"], ["acme-old-build-cache", "warning", undefined]]);

  // The exposed staging database (its RDS row comes from the ecs package; here only what R4 reads of it).
  const pg: Resource = {
    key: "rds:acme-staging-pg", kind: "rds", provider: "rds", name: "acme-staging-pg", region: "us-east-1", tags: {}, health: "ok", props: [],
    vpcId: "vpc-stg", subnetIds: ["subnet-stg-private-a", "subnet-stg-private-b"], securityGroups: ["sg-stg-db"], facts: { public: true },
  };
  const all = [...res("vpc@us-east-1"), ...res("security-group@us-east-1"), pg];
  const p = propagate({ resources: all, edges: [], now: NOW });
  const after = p.resources.find((r) => r.key === pg.key)!;
  assert.deepEqual([after.health, after.healthReason], ["error", "reachable from the internet on 5432/tcp (sg-stg-db allows 0.0.0.0/0)"]);
  assert.ok(p.edges.some((e) => e.from === "external:internet" && e.to === pg.key));
  assert.deepEqual(p.resources.filter((r) => r.idle).map((r) => r.name), ["old-bastion"]);
});
