// Simulated security groups, per region (the provider sets multiRegionMock), in the SDK's shapes so the real mapping
// runs. The ECS side's groups come from the simulated account itself (../../mock.ts, so both agree on
// every rule — including sg-stg-db admitting 5432 from 0.0.0.0/0, the exposed staging database); around them, what a
// real VPC also holds: a default group per VPC (it admits itself), the bastion's group (22/tcp from the office), one
// nobody uses (no interfaces, not referenced: unused), and web ports on the load balancer's group. Network interfaces
// follow the simulated estate as it is now: one per running awsvpc task, ECS host, database and cache node, plus the
// load balancer's two and the bastion's. eu-west-1: the eu estate's three groups. Other regions: none.
import type { RawEni, RawPermission, RawSecurityGroup, RawSgRule } from "../../../inventory/security-group.ts";
import type { RawSecurityGroup as EcsGroup } from "../../../types.ts";
import { ACCT, EC2, EU, EU_REGION, EXISTING, NETWORK, REGION, SECURITY_GROUPS } from "../mock-names.ts";

// The simulated account itself (../../mock.ts), read directly rather than through getCloud(): the same estate, and the
// console's own Cloud reads (what the inventory counts as "security groups read twice") stay untouched. Loaded on use,
// so a real-AWS console never loads the simulation.
const simAccount = async (region: string) => (await import("../../mock.ts")).mockCloud(region);

interface Inbound { proto: string; from?: number; to?: number; cidrs?: string[]; groups?: string[]; description?: string }
interface Spec { id: string; name: string; vpc: string; description: string; inbound: Inbound[]; tags?: Record<string, string> }

const WEB: Inbound[] = [80, 443].map((p) => ({ proto: "tcp", from: p, to: p, cidrs: ["0.0.0.0/0", "::/0"] }));
const fromEcs = (g: EcsGroup): Spec => ({
  id: g.id, name: g.name, vpc: g.vpcId ?? "", description: `${g.name} (ECS)`,
  inbound: g.inbound.map((i) => ({ proto: "tcp", from: i.fromPort, to: i.toPort, cidrs: [...(i.cidrs ?? [])], groups: [...i.groups], ...(i.description ? { description: i.description } : {}) })),
});

// Stable ids from what an interface belongs to.
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

async function specs(region: string): Promise<Spec[]> {
  const cloud = await simAccount(region);
  if (region === REGION) {
    const ecs = (await cloud.securityGroups(Object.values(EXISTING.securityGroups))).map(fromEcs);
    const alb = ecs.find((g) => g.id === EXISTING.securityGroups.prodAlb);
    if (alb) alb.inbound.push(...WEB);
    const self = (id: string) => [{ proto: "-1", groups: [id] }];
    return [
      ...ecs,
      { id: SECURITY_GROUPS.defaults.production, name: "default", vpc: NETWORK.production.vpc, description: "default VPC security group", inbound: self(SECURITY_GROUPS.defaults.production) },
      { id: SECURITY_GROUPS.defaults.staging, name: "default", vpc: NETWORK.staging.vpc, description: "default VPC security group", inbound: self(SECURITY_GROUPS.defaults.staging) },
      { id: SECURITY_GROUPS.bastion.id, name: SECURITY_GROUPS.bastion.name, vpc: SECURITY_GROUPS.bastion.vpc, description: "SSH from the office", inbound: [{ proto: "tcp", from: 22, to: 22, cidrs: [SECURITY_GROUPS.officeCidr], description: "office" }] },
      { id: SECURITY_GROUPS.unused.id, name: SECURITY_GROUPS.unused.name, vpc: SECURITY_GROUPS.unused.vpc, description: "old bastion (replaced)", inbound: [{ proto: "tcp", from: 22, to: 22, cidrs: [SECURITY_GROUPS.officeCidr] }], tags: { Owner: "platform" } },
    ];
  }
  if (region === EU_REGION) return (await cloud.securityGroups(Object.values(EU.securityGroups))).map(fromEcs);
  return [];
}

function toGroup(s: Spec): RawSecurityGroup {
  const perms: RawPermission[] = s.inbound.map((i) => ({
    IpProtocol: i.proto, FromPort: i.from ?? -1, ToPort: i.to ?? -1,
    IpRanges: (i.cidrs ?? []).filter((c) => !c.includes(":")).map((c) => ({ CidrIp: c, ...(i.description ? { Description: i.description } : {}) })),
    Ipv6Ranges: (i.cidrs ?? []).filter((c) => c.includes(":")).map((c) => ({ CidrIpv6: c, ...(i.description ? { Description: i.description } : {}) })),
    PrefixListIds: [],
    UserIdGroupPairs: (i.groups ?? []).map((g) => ({ GroupId: g, UserId: ACCT, ...(i.description ? { Description: i.description } : {}) })),
  }));
  return {
    GroupId: s.id, GroupName: s.name, Description: s.description, VpcId: s.vpc, OwnerId: ACCT,
    Tags: Object.entries(s.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
    IpPermissions: perms, IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }], Ipv6Ranges: [], PrefixListIds: [], UserIdGroupPairs: [] }],
  };
}

function toRules(s: Spec): RawSgRule[] {
  const out: RawSgRule[] = [];
  const base = (i: Inbound, egress: boolean) => ({ GroupId: s.id, GroupOwnerId: ACCT, IsEgress: egress, IpProtocol: i.proto, FromPort: i.from ?? -1, ToPort: i.to ?? -1, ...(i.description ? { Description: i.description } : {}) });
  for (const i of s.inbound) {
    for (const c of i.cidrs ?? []) out.push({ ...base(i, false), SecurityGroupRuleId: `sgr-${hash(`${s.id}/${i.proto}/${i.from}/${c}`)}`, ...(c.includes(":") ? { CidrIpv6: c } : { CidrIpv4: c }) });
    for (const g of i.groups ?? []) out.push({ ...base(i, false), SecurityGroupRuleId: `sgr-${hash(`${s.id}/${i.proto}/${i.from}/${g}`)}`, ReferencedGroupInfo: { GroupId: g, UserId: ACCT } });
  }
  out.push({ ...base({ proto: "-1" }, true), SecurityGroupRuleId: `sgr-${hash(`${s.id}/egress`)}`, CidrIpv4: "0.0.0.0/0" });
  return out;
}

// One interface per thing in the estate that sits in a group.
async function interfaces(region: string): Promise<RawEni[]> {
  const cloud = await simAccount(region);
  const out: RawEni[] = [];
  const eni = (owner: string, groups: string[], o: Partial<RawEni>): RawEni => ({
    NetworkInterfaceId: `eni-0acme${hash(owner)}`, InterfaceType: "interface", Status: "in-use", Groups: groups.map((g) => ({ GroupId: g })), ...o,
  });
  // A task's subnet from its address (10.20.10.x → the first private subnet, 10.20.11.x → the second).
  const subnetOf = (ip: string | undefined, subnets: string[]) => subnets[(Number(ip?.split(".")[2] ?? 10) - 10 + subnets.length) % Math.max(1, subnets.length)];
  for (const c of await cloud.clusters()) {
    for (const s of await cloud.services(c.name))
      for (const t of s.tasks)
        if (t.lastStatus === "RUNNING" && t.privateIp && s.securityGroups.length)
          out.push(eni(`task/${t.id}`, s.securityGroups, {
            RequesterManaged: true, Description: `arn:aws:ecs:${region}:${ACCT}:attachment/${hash(t.id)}-${hash(`${t.id}/a`)}`, SubnetId: subnetOf(t.privateIp, s.subnets), PrivateIpAddress: t.privateIp,
          }));
    for (const h of await cloud.hosts(c.name))
      if (h.securityGroups.length) out.push(eni(`host/${h.id}`, h.securityGroups, { Attachment: { InstanceId: h.id, InstanceOwnerId: ACCT }, PrivateIpAddress: h.privateIp, SubnetId: EXISTING.subnets.staging[0], ...(h.publicIp ? { Association: { PublicIp: h.publicIp } } : {}) }));
  }
  for (const d of await cloud.databases())
    if (d.securityGroups.length) out.push(eni(`rds/${d.id}`, d.securityGroups, { RequesterManaged: true, RequesterId: "amazon-rds", Description: "RDSNetworkInterface", SubnetId: d.subnetIds?.[0] }));
  for (const c of await cloud.caches())
    for (const m of c.memberClusters?.length ? c.memberClusters : [c.id])
      if (c.securityGroups.length) out.push(eni(`cache/${m}`, c.securityGroups, { RequesterManaged: true, RequesterId: "amazon-elasticache", Description: `ElastiCache ${m}`, SubnetId: c.subnetIds?.[0] }));
  if (region === REGION) {
    const alb = EXISTING.alb.arn.split(":loadbalancer/")[1];
    NETWORK.production.publicSubnets.forEach((sub, i) =>
      out.push(eni(`alb/${i}`, [EXISTING.securityGroups.prodAlb], { RequesterManaged: true, RequesterId: "amazon-elb", Description: `ELB ${alb}`, SubnetId: sub, PrivateIpAddress: `10.20.${i}.${30 + i}` })),
    );
    out.push(eni(`instance/${EC2.bastion.id}`, [SECURITY_GROUPS.bastion.id], { Attachment: { InstanceId: EC2.bastion.id, InstanceOwnerId: ACCT }, SubnetId: NETWORK.production.publicSubnets[0], PrivateIpAddress: "10.20.0.20", Association: { PublicIp: EC2.bastion.publicIp } }));
  }
  return out;
}

export async function simSecurityGroups(region: string): Promise<{ groups: RawSecurityGroup[]; rules: RawSgRule[]; enis: RawEni[] }> {
  const list = await specs(region);
  return { groups: list.map(toGroup), rules: list.flatMap(toRules), enis: list.length ? await interfaces(region) : [] };
}
