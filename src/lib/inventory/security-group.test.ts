import { test } from "node:test";
import assert from "node:assert/strict";
import { eniOwner, eniRows, groupFacts, ownersSummary, portEntry, ruleRows, rulesFromApi, rulesFromPermissions, securityGroupResults, type RawEni, type RawSecurityGroup, type RawSgRule } from "./security-group.ts";
import { propagate } from "./propagate.ts";
import type { Resource } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_5c1e";
const arn = (id: string) => `arn:aws:ec2:${R}:${ACCT}:security-group/${id}`;

// The real pattern behind F04, anonymised: a database group with 5432 open to the world, two /32s, the peered VPC's
// /16 and the tasks' group; the tasks' group admits the load balancer's and itself; the load balancer's is open on
// 80/443 (IPv4 and IPv6); a default group referencing itself; a group nobody uses.
const groups: RawSecurityGroup[] = [
  { GroupId: "sg-db", GroupName: "acme-production-db", Description: "Postgres", VpcId: "vpc-prod", OwnerId: ACCT, Tags: [{ Key: "Environment", Value: "production" }] },
  { GroupId: "sg-tasks", GroupName: "acme-production-tasks", Description: "ECS tasks", VpcId: "vpc-prod", OwnerId: ACCT },
  { GroupId: "sg-alb", GroupName: "acme-production-alb", Description: "ALB", VpcId: "vpc-prod", OwnerId: ACCT, Tags: [{ Key: "Name", Value: "public alb" }] },
  { GroupId: "sg-default", GroupName: "default", Description: "default VPC security group", VpcId: "vpc-prod", OwnerId: ACCT },
  { GroupId: "sg-old", GroupName: "old-bastion", Description: "nobody", VpcId: "vpc-prod", OwnerId: ACCT },
];
const rule = (id: string, group: string, o: Partial<RawSgRule>): RawSgRule => ({
  SecurityGroupRuleId: id, GroupId: group, GroupOwnerId: ACCT, IsEgress: false, IpProtocol: "tcp", ...o,
  ...({ Tags: [{ Key: "secret", Value: SENTINEL }], SecurityGroupRuleArn: `arn:aws:ec2:${R}:${ACCT}:security-group-rule/${id}` } as object),
});
const rules: RawSgRule[] = [
  rule("sgr-1", "sg-db", { FromPort: 5432, ToPort: 5432, CidrIpv4: "0.0.0.0/0", Description: "OPEN FOR TESTING" }),
  rule("sgr-2", "sg-db", { FromPort: 5432, ToPort: 5432, CidrIpv4: "203.0.113.5/32", Description: "admin laptop" }),
  rule("sgr-3", "sg-db", { FromPort: 5432, ToPort: 5432, CidrIpv4: "198.51.100.9/32" }),
  rule("sgr-4", "sg-db", { FromPort: 5432, ToPort: 5432, CidrIpv4: "10.30.0.0/16", Description: "migration host via peering" }),
  rule("sgr-5", "sg-db", { FromPort: 5432, ToPort: 5432, ReferencedGroupInfo: { GroupId: "sg-tasks", UserId: ACCT }, Description: "from tasks" }),
  rule("sgr-6", "sg-tasks", { FromPort: 3000, ToPort: 3000, ReferencedGroupInfo: { GroupId: "sg-alb", UserId: ACCT } }),
  rule("sgr-7", "sg-tasks", { FromPort: 0, ToPort: 65535, ReferencedGroupInfo: { GroupId: "sg-tasks", UserId: ACCT }, Description: "task to task" }),
  rule("sgr-8", "sg-alb", { FromPort: 80, ToPort: 80, CidrIpv4: "0.0.0.0/0" }),
  rule("sgr-9", "sg-alb", { FromPort: 443, ToPort: 443, CidrIpv4: "0.0.0.0/0" }),
  rule("sgr-10", "sg-alb", { FromPort: 80, ToPort: 80, CidrIpv6: "::/0" }),
  rule("sgr-11", "sg-alb", { FromPort: 443, ToPort: 443, CidrIpv6: "::/0" }),
  rule("sgr-12", "sg-default", { IpProtocol: "-1", FromPort: -1, ToPort: -1, ReferencedGroupInfo: { GroupId: "sg-default", UserId: ACCT } }),
  rule("sgr-13", "sg-old", { FromPort: 22, ToPort: 22, CidrIpv4: "198.51.100.10/32" }),
  ...["sg-db", "sg-tasks", "sg-alb", "sg-default", "sg-old"].map((g, i) => rule(`sgr-e${i}`, g, { IsEgress: true, IpProtocol: "-1", FromPort: -1, ToPort: -1, CidrIpv4: "0.0.0.0/0" })),
];
const eni = (id: string, sg: string, o: Partial<RawEni>): RawEni => ({
  NetworkInterfaceId: id, InterfaceType: "interface", Status: "in-use", SubnetId: "subnet-a", VpcId: "vpc-prod", PrivateIpAddress: "10.20.10.5",
  Groups: [{ GroupId: sg, GroupName: "x" }], ...o, ...({ MacAddress: SENTINEL, TagSet: [{ Key: "k", Value: SENTINEL }] } as object),
});
const enis: RawEni[] = [
  eni("eni-1", "sg-db", { RequesterManaged: true, RequesterId: "amazon-rds", Description: "RDSNetworkInterface" }),
  eni("eni-2", "sg-tasks", { RequesterManaged: true, Description: `arn:aws:ecs:${R}:${ACCT}:attachment/0f1e2d3c-1111` }),
  eni("eni-3", "sg-tasks", { RequesterManaged: true, Description: `arn:aws:ecs:${R}:${ACCT}:attachment/0f1e2d3c-2222` }),
  eni("eni-4", "sg-alb", { RequesterManaged: true, RequesterId: "amazon-elb", Description: "ELB app/acme-production/5f2c1a9d3e7b4c60", Association: { PublicIp: "203.0.113.50" } }),
];

const by = (res: Resource[], id: string) => res.find((r) => r.key === arn(id))!;

test("golden: the exposed database group — facts R4 and R7 read, a warning, its inbound rules for allowed edges", () => {
  const { resources, sgRules } = securityGroupResults({ groups, rules, enis, region: R, accountId: ACCT, now: NOW });
  assert.equal(resources.length, 5);
  assert.deepEqual(by(resources, "sg-db"), {
    key: arn("sg-db"), kind: "security-group", provider: "security-group", name: "acme-production-db", region: R, tags: { Environment: "production" },
    health: "warning", healthReason: "open to the internet on 5432/tcp",
    props: [
      { label: "Group id", value: "sg-db", mono: true }, { label: "Description", value: "Postgres" }, { label: "VPC", value: "vpc-prod", mono: true },
      { label: "Inbound rules", value: "5" }, { label: "Outbound rules", value: "1" }, { label: "Open to the internet", value: "5432/tcp" },
      { label: "Other sources", value: "5432/tcp ← 203.0.113.5/32, 5432/tcp ← 198.51.100.9/32, 5432/tcp ← 10.30.0.0/16" },
      { label: "Network interfaces", value: "1 (RDS database ×1)" },
    ],
    aliases: ["sg-db"], vpcId: "vpc-prod", parent: `arn:aws:ec2:${R}:${ACCT}:vpc/vpc-prod`,
    consoleUrl: `https://${R}.console.aws.amazon.com/ec2/home?region=${R}#SecurityGroup:groupId=sg-db`,
    facts: { openIngress: ["5432/tcp"], cidrIngress: ["5432/tcp<-203.0.113.5/32", "5432/tcp<-198.51.100.9/32", "5432/tcp<-10.30.0.0/16"], referencedBy: 0, isDefault: false, attachments: 1 },
    observedAt: NOW, enrichment: { rules: "ok", interfaces: "ok" },
  });
  assert.deepEqual(sgRules.find((g) => g.groupId === "sg-db"), {
    groupId: "sg-db", vpcId: "vpc-prod", region: R, name: "acme-production-db",
    inbound: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, groups: ["sg-tasks"], cidrs: ["0.0.0.0/0", "203.0.113.5/32", "198.51.100.9/32", "10.30.0.0/16"], prefixLists: [], description: "OPEN FOR TESTING" }],
  });
  const json = JSON.stringify({ resources, sgRules });
  assert.ok(!json.includes(SENTINEL), "rule tags, MAC addresses and interface tags never reach the output");
});

test("web ports open to the world are fine, referenced groups count, self-references don't, default groups never idle", () => {
  const { resources } = securityGroupResults({ groups, rules, enis, region: R, accountId: ACCT });
  const alb = by(resources, "sg-alb");
  assert.deepEqual([alb.health, alb.facts?.openIngress, alb.name], ["ok", ["80/tcp", "443/tcp"], "acme-production-alb"]);
  assert.equal(alb.props.find((p) => p.label === "Name tag")?.value, "public alb");
  assert.equal(by(resources, "sg-alb").facts?.referencedBy, 1, "sg-tasks admits it");
  assert.equal(by(resources, "sg-tasks").facts?.referencedBy, 1, "sg-db admits it; its own task-to-task rule doesn't count");
  assert.equal(by(resources, "sg-tasks").props.find((p) => p.label === "Referenced by")?.value, "sg-db");
  const def = by(resources, "sg-default");
  assert.deepEqual([def.facts?.isDefault, def.facts?.referencedBy, def.facts?.attachments, def.facts?.openIngress], [true, 0, 0, []]);

  // R7 marks only the group nobody uses; R4 doesn't fire without a publicly addressable resource.
  const out = propagate({ resources, edges: [], now: NOW });
  const idle = out.resources.filter((r) => r.idle).map((r) => r.name);
  assert.deepEqual(idle, ["old-bastion"]);
});

test("protocols: all traffic, ICMP, numbers, port ranges", () => {
  assert.equal(portEntry({ protocol: "all" }), "all");
  assert.equal(portEntry({ protocol: "tcp", fromPort: 1024, toPort: 65535 }), "1024-65535/tcp");
  assert.equal(portEntry({ protocol: "udp", fromPort: 53, toPort: 53 }), "53/udp");
  assert.equal(portEntry({ protocol: "tcp" }), "0-65535/tcp");
  assert.equal(portEntry({ protocol: "icmp" }), "icmp");
  const g: RawSecurityGroup = { GroupId: "sg-x", GroupName: "x", VpcId: "vpc-1", OwnerId: ACCT };
  const r = securityGroupResults({
    groups: [g], region: R, accountId: ACCT,
    rules: [
      { GroupId: "sg-x", IpProtocol: "-1", FromPort: -1, ToPort: -1, CidrIpv6: "::/0" },
      { GroupId: "sg-x", IpProtocol: "icmp", FromPort: 8, ToPort: -1, CidrIpv4: "0.0.0.0/0" },
      { GroupId: "sg-x", IpProtocol: "6", FromPort: 22, ToPort: 22, CidrIpv4: "0.0.0.0/0" },
      { GroupId: "sg-x", IpProtocol: "50", CidrIpv4: "10.0.0.0/8" },
    ],
  });
  const x = r.resources[0];
  assert.deepEqual(x.facts?.openIngress, ["all", "icmp", "22/tcp"]);
  assert.deepEqual(x.facts?.cidrIngress, ["50<-10.0.0.0/8"]);
  assert.equal(x.healthReason, "open to the internet on all ports, 22/tcp");
  assert.deepEqual(r.sgRules[0].inbound.map((i) => [i.protocol, i.fromPort, i.toPort]), [["all", undefined, undefined], ["icmp", undefined, undefined], ["tcp", 22, 22], ["50", undefined, undefined]]);
  assert.equal(x.facts?.attachments, undefined, "interfaces not read: no attachment count, so never unused");
  assert.deepEqual(x.enrichment, { rules: "ok", interfaces: "skipped" });
});

test("the groups' IpPermissions give the same rules as DescribeSecurityGroupRules (fallback and checkpoint)", () => {
  const perms: RawSecurityGroup[] = [
    {
      ...groups[0],
      IpPermissions: [
        { IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "OPEN FOR TESTING" }, { CidrIp: "203.0.113.5/32", Description: "admin laptop" }, { CidrIp: "198.51.100.9/32" }, { CidrIp: "10.30.0.0/16", Description: "migration host via peering" }], UserIdGroupPairs: [{ GroupId: "sg-tasks", UserId: ACCT, Description: "from tasks" }] },
      ],
      IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
    },
  ];
  const fromApi = securityGroupResults({ groups: [groups[0]], rules: rules.filter((r) => r.GroupId === "sg-db"), enis, region: R, accountId: ACCT });
  const fromPerms = securityGroupResults({ groups: perms, enis, region: R, accountId: ACCT, rulesState: "denied" });
  assert.deepEqual(fromPerms.resources[0].facts, fromApi.resources[0].facts);
  assert.deepEqual(fromPerms.sgRules, fromApi.sgRules);
  assert.deepEqual(fromPerms.resources[0].enrichment, { rules: "denied", interfaces: "ok" });
  assert.deepEqual(
    rulesFromPermissions(perms).map((r) => [r.egress, r.protocol, r.cidr ?? r.group]),
    rulesFromApi(rules.filter((r) => r.GroupId === "sg-db")).map((r) => [r.egress, r.protocol, r.cidr ?? r.group]).sort((a, b) => Number(a[0]) - Number(b[0])),
  );
  assert.equal(groupFacts(groups[1], [], R).inbound.length, 0);
});

test("another account's group keeps its owner in the key; network interfaces name their owners", () => {
  const r = securityGroupResults({ groups: [{ GroupId: "sg-shared", GroupName: "shared", VpcId: "vpc-s", OwnerId: "210987654321" }], rules: [], enis: [], region: R, accountId: ACCT });
  assert.deepEqual([r.resources[0].key, r.resources[0].account, r.resources[0].parent], [`arn:aws:ec2:${R}:210987654321:security-group/sg-shared`, "210987654321", `arn:aws:ec2:${R}:210987654321:vpc/vpc-s`]);
  assert.deepEqual(enis.map(eniOwner), ["RDS database", "ECS task", "ECS task", "load balancer"]);
  assert.equal(eniOwner({ InterfaceType: "nat_gateway" }), "NAT gateway");
  assert.equal(eniOwner({ Description: "AWS Lambda VPC ENI-acme-orders-1a2b" }), "Lambda function");
  assert.equal(eniOwner({ Attachment: { InstanceId: "i-1" } }), "EC2 instance");
  assert.equal(eniOwner({ InterfaceType: "api_gateway_managed" }), "api gateway managed");
  assert.equal(ownersSummary(enis), "ECS task ×2 · load balancer ×1 · RDS database ×1");
  assert.deepEqual(eniRows([enis[3]]), [["eni-4", "load balancer app/acme-production/5f2c1a9d3e7b4c60", "subnet-a", "10.20.10.5 · 203.0.113.50", "in-use"]]);
  assert.deepEqual(ruleRows(rulesFromApi(rules.filter((x) => x.GroupId === "sg-tasks")), false), [["tcp", "3000", "sg-alb (account 123456789012)", ""], ["tcp", "0-65535", "sg-tasks (account 123456789012)", "task to task"]]);
  assert.deepEqual(ruleRows(rulesFromApi(rules.filter((x) => x.GroupId === "sg-tasks")), true), [["all", "all", "0.0.0.0/0", ""]]);
  assert.deepEqual(ruleRows(rulesFromApi(rules.filter((x) => x.GroupId === "sg-tasks")), false, ACCT).map((r) => r[2]), ["sg-alb", "sg-tasks"], "the console's own account isn't repeated");
  assert.deepEqual(ruleRows(rulesFromApi([{ GroupId: "sg-x", IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, ReferencedGroupInfo: { GroupId: "sg-peer", UserId: "210987654321", VpcPeeringConnectionId: "pcx-1" } }]), false, ACCT), [["tcp", "5432", "sg-peer (account 210987654321) via pcx-1", ""]]);
});
