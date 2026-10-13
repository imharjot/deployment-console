// Security groups as the cloud map sees them, pure: SDK-shaped DescribeSecurityGroups, DescribeSecurityGroupRules and
// DescribeNetworkInterfaces answers in; map resources with the facts the cross-resource rules read (exposure R4,
// unused R7) and the inbound rules the inventory's "allowed" edges use (ProviderResult.sgRules, CC-19) out. The
// provider (../server/providers/security-group.ts) and its simulation feed the same functions. No AWS calls.
//
// Facts (types.ts lists the names):
// - openIngress: ports open from 0.0.0.0/0 or ::/0 — "5432/tcp", "1024-65535/tcp", "all" (protocol -1), "icmp";
// - cidrIngress: the other CIDRs — "5432/tcp<-10.30.0.0/16";
// - attachments: how many network interfaces use the group (only when every interface was read);
// - referencedBy: rules in other groups that name this one (inbound or outbound) — a group they name isn't unused;
// - isDefault: the VPC's "default" group (never unused).
import { arnOf } from "./arn.ts";
import { prop, props, uniq } from "./compute-common.ts";
import { enrichmentOf, tagMap } from "./serverless-common.ts";
import type { EnrichState, Prop, Resource, SecurityGroupFacts } from "./types.ts";

// ---------- raw shapes (the SDK's field names; dates as Date or ISO strings) ----------

export interface RawTag { Key?: string; Value?: string }
interface RawPair { GroupId?: string; UserId?: string; VpcId?: string; VpcPeeringConnectionId?: string; PeeringStatus?: string; Description?: string }
export interface RawPermission {
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  IpRanges?: { CidrIp?: string; Description?: string }[];
  Ipv6Ranges?: { CidrIpv6?: string; Description?: string }[];
  PrefixListIds?: { PrefixListId?: string; Description?: string }[];
  UserIdGroupPairs?: RawPair[];
}
export interface RawSecurityGroup {
  GroupId?: string;
  GroupName?: string;
  Description?: string;
  VpcId?: string;
  OwnerId?: string;
  Tags?: RawTag[];
  IpPermissions?: RawPermission[];
  IpPermissionsEgress?: RawPermission[];
}
export interface RawSgRule {
  SecurityGroupRuleId?: string;
  GroupId?: string;
  GroupOwnerId?: string;
  IsEgress?: boolean;
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  CidrIpv4?: string;
  CidrIpv6?: string;
  PrefixListId?: string;
  ReferencedGroupInfo?: RawPair;
  Description?: string;
}
export interface RawEni {
  NetworkInterfaceId?: string;
  InterfaceType?: string;
  Description?: string;
  RequesterId?: string;
  RequesterManaged?: boolean;
  Status?: string;
  SubnetId?: string;
  VpcId?: string;
  PrivateIpAddress?: string;
  Association?: { PublicIp?: string };
  Attachment?: { InstanceId?: string; InstanceOwnerId?: string };
  Groups?: { GroupId?: string; GroupName?: string }[];
}

// ---------- rules ----------

// One rule, whichever API it came from: one source (a CIDR, an IPv6 CIDR, a prefix list or a group) per rule.
export interface Rule {
  groupId: string;
  egress: boolean;
  protocol: string; // "tcp" | "udp" | "icmp" | "icmpv6" | "all" | an IP protocol number
  fromPort?: number; // tcp/udp only
  toPort?: number;
  cidr?: string;
  prefixList?: string;
  group?: string; // a referenced group id
  groupAccount?: string;
  peering?: string;
  description?: string;
}

export function normProtocol(p: string | undefined): string {
  const s = String(p ?? "-1").toLowerCase();
  if (s === "-1" || s === "all") return "all";
  return ({ "6": "tcp", "17": "udp", "1": "icmp", "58": "icmpv6" } as Record<string, string>)[s] ?? s;
}
const ported = (proto: string) => proto === "tcp" || proto === "udp";
const portsOf = (proto: string, from?: number, to?: number) =>
  ported(proto) && typeof from === "number" && from >= 0 ? { fromPort: from, toPort: typeof to === "number" && to >= 0 ? to : from } : {};

// "5432/tcp", "1024-65535/tcp", "all", "icmp" — the spelling of the openIngress / cidrIngress facts.
export function portEntry(r: Pick<Rule, "protocol" | "fromPort" | "toPort">): string {
  if (r.protocol === "all") return "all";
  if (!ported(r.protocol)) return r.protocol;
  if (r.fromPort === undefined) return `0-65535/${r.protocol}`;
  return r.fromPort === r.toPort ? `${r.fromPort}/${r.protocol}` : `${r.fromPort}-${r.toPort}/${r.protocol}`;
}

// DescribeSecurityGroupRules: one rule per item.
export function rulesFromApi(items: RawSgRule[]): Rule[] {
  const out: Rule[] = [];
  for (const x of items) {
    if (!x?.GroupId) continue;
    const protocol = normProtocol(x.IpProtocol);
    const ref = x.ReferencedGroupInfo;
    out.push({
      groupId: x.GroupId, egress: x.IsEgress === true, protocol, ...portsOf(protocol, x.FromPort, x.ToPort),
      ...(x.CidrIpv4 ? { cidr: x.CidrIpv4 } : x.CidrIpv6 ? { cidr: x.CidrIpv6 } : {}), ...(x.PrefixListId ? { prefixList: x.PrefixListId } : {}),
      ...(ref?.GroupId ? { group: ref.GroupId, ...(ref.UserId ? { groupAccount: ref.UserId } : {}), ...(ref.VpcPeeringConnectionId ? { peering: ref.VpcPeeringConnectionId } : {}) } : {}),
      ...(x.Description ? { description: x.Description } : {}),
    });
  }
  return out;
}

// DescribeSecurityGroups' IpPermissions(Egress): the same rules, grouped by protocol and ports (the fallback when the
// rules call is denied or cut short, and the checkpoint's source).
export function rulesFromPermissions(groups: RawSecurityGroup[]): Rule[] {
  const out: Rule[] = [];
  for (const g of groups) {
    if (!g?.GroupId) continue;
    for (const [egress, list] of [[false, g.IpPermissions], [true, g.IpPermissionsEgress]] as const)
      for (const p of list ?? []) {
        const protocol = normProtocol(p.IpProtocol);
        const base = { groupId: g.GroupId, egress, protocol, ...portsOf(protocol, p.FromPort, p.ToPort) };
        const desc = (d?: string) => (d ? { description: d } : {});
        for (const x of p.IpRanges ?? []) if (x.CidrIp) out.push({ ...base, cidr: x.CidrIp, ...desc(x.Description) });
        for (const x of p.Ipv6Ranges ?? []) if (x.CidrIpv6) out.push({ ...base, cidr: x.CidrIpv6, ...desc(x.Description) });
        for (const x of p.PrefixListIds ?? []) if (x.PrefixListId) out.push({ ...base, prefixList: x.PrefixListId, ...desc(x.Description) });
        for (const x of p.UserIdGroupPairs ?? [])
          if (x.GroupId)
            out.push({ ...base, group: x.GroupId, ...(x.UserId ? { groupAccount: x.UserId } : {}), ...(x.VpcPeeringConnectionId ? { peering: x.VpcPeeringConnectionId } : {}), ...desc(x.Description) });
      }
  }
  return out;
}

const WORLD = new Set(["0.0.0.0/0", "::/0"]);
const webPort = (entry: string) => /^(80|443)\/[a-z0-9]+$/.test(entry);
// Port entries that say something about exposure (ICMP and other port-less protocols don't).
const exposing = (entry: string) => entry === "all" || /^\d+(-\d+)?\/(tcp|udp)$/.test(entry);

// The inbound rules of one group as the inventory's "allowed" edges read them: one entry per protocol and port range.
export function groupFacts(g: RawSecurityGroup, rules: Rule[], region: string): SecurityGroupFacts {
  const by = new Map<string, SecurityGroupFacts["inbound"][number]>();
  for (const r of rules) {
    if (r.egress) continue;
    const k = `${r.protocol}|${r.fromPort ?? ""}|${r.toPort ?? ""}`;
    const e = by.get(k) ?? by.set(k, { protocol: r.protocol, ...(r.fromPort !== undefined ? { fromPort: r.fromPort, toPort: r.toPort } : {}), groups: [], cidrs: [], prefixLists: [] }).get(k)!;
    if (r.group && !e.groups.includes(r.group)) e.groups.push(r.group);
    if (r.cidr && !e.cidrs.includes(r.cidr)) e.cidrs.push(r.cidr);
    if (r.prefixList && !e.prefixLists.includes(r.prefixList)) e.prefixLists.push(r.prefixList);
    if (r.description && !e.description) e.description = r.description;
  }
  return { groupId: g.GroupId!, ...(g.VpcId ? { vpcId: g.VpcId } : {}), region, ...(g.GroupName ? { name: g.GroupName } : {}), inbound: [...by.values()] };
}

// ---------- network interfaces ----------

// What a network interface belongs to, from its type, description and attachment ("ECS task", "load balancer"…).
export function eniOwner(e: RawEni): string {
  const d = e.Description ?? "";
  const type = e.InterfaceType ?? "";
  if (type === "nat_gateway" || /^Interface for NAT Gateway/i.test(d)) return "NAT gateway";
  if (type === "vpc_endpoint" || type === "gateway_load_balancer_endpoint" || /^VPC Endpoint Interface/i.test(d)) return "VPC endpoint";
  if (type === "network_load_balancer" || type === "gateway_load_balancer" || /^ELB /.test(d)) return "load balancer";
  if (type === "lambda" || /^AWS Lambda VPC ENI/i.test(d)) return "Lambda function";
  if (type === "efs" || /^EFS mount target/i.test(d)) return "EFS mount target";
  if (type === "transit_gateway") return "transit gateway";
  if (/^RDSNetworkInterface/.test(d)) return "RDS database";
  if (/^ElastiCache /.test(d)) return "ElastiCache node";
  if (/^arn:aws[\w-]*:ecs:[^:]+:\d+:attachment\//.test(d)) return "ECS task";
  if (/^Amazon EKS/i.test(d)) return "EKS";
  if (e.Attachment?.InstanceId) return "EC2 instance";
  if (type && type !== "interface") return type.replaceAll("_", " ");
  return "network interface";
}
// "ECS task ×2 · RDS database ×1"
export function ownersSummary(enis: RawEni[]): string {
  const n = new Map<string, number>();
  for (const e of enis) n.set(eniOwner(e), (n.get(eniOwner(e)) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ×${v}`).join(" · ");
}

// ---------- resources ----------

export interface SgInput {
  groups: RawSecurityGroup[];
  rules?: RawSgRule[]; // undefined: not read (the groups' IpPermissions are used)
  enis?: RawEni[]; // undefined: not read completely (attachments unknown — never "unused")
  region: string;
  accountId?: string;
  now?: number;
  rulesState?: EnrichState; // how the rules read went (ok when `rules` is set)
  enisState?: EnrichState;
}

const consoleUrl = (region: string, id: string) => `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#SecurityGroup:groupId=${encodeURIComponent(id)}`;

export function securityGroupResults(input: SgInput): { resources: Resource[]; sgRules: SecurityGroupFacts[] } {
  const { region } = input;
  const groups = input.groups.filter((g) => g?.GroupId);
  const rules = input.rules ? rulesFromApi(input.rules) : rulesFromPermissions(groups);
  const byGroup = new Map<string, Rule[]>();
  for (const r of rules) byGroup.set(r.groupId, [...(byGroup.get(r.groupId) ?? []), r]);
  // referencedBy: rules in *other* groups naming this one.
  const refs = new Map<string, Set<string>>();
  const refCount = new Map<string, number>();
  for (const r of rules)
    if (r.group && r.group !== r.groupId) {
      refCount.set(r.group, (refCount.get(r.group) ?? 0) + 1);
      (refs.get(r.group) ?? refs.set(r.group, new Set()).get(r.group)!).add(r.groupId);
    }
  const enis = new Map<string, RawEni[]>();
  for (const e of input.enis ?? []) for (const g of e.Groups ?? []) if (g.GroupId) enis.set(g.GroupId, [...(enis.get(g.GroupId) ?? []), e]);
  const enisState: EnrichState | undefined = input.enis ? "ok" : input.enisState ?? "skipped";
  const rulesState: EnrichState | undefined = input.rules ? "ok" : input.rulesState;

  const resources = groups.map((g): Resource => {
    const id = g.GroupId!;
    const account = g.OwnerId || input.accountId || "";
    const mine = byGroup.get(id) ?? [];
    const inbound = mine.filter((r) => !r.egress);
    const open = uniq(inbound.filter((r) => r.cidr && WORLD.has(r.cidr)).map(portEntry));
    const cidrIngress = uniq(inbound.filter((r) => r.cidr && !WORLD.has(r.cidr)).map((r) => `${portEntry(r)}<-${r.cidr}`));
    const exposed = open.filter((e) => exposing(e) && !webPort(e));
    const used = enis.get(id) ?? [];
    const tags = tagMap(g.Tags ?? []);
    const isDefault = g.GroupName === "default";
    const referencedBy = refCount.get(id) ?? 0;
    const facts: Resource["facts"] = {
      openIngress: open, cidrIngress, referencedBy, isDefault,
      ...(input.enis ? { attachments: used.length } : {}),
    };
    const enrichment = enrichmentOf({ rules: rulesState, interfaces: enisState });
    const p: Prop[] = props(
      prop("Group id", id, true),
      tags.Name && tags.Name !== g.GroupName ? prop("Name tag", tags.Name) : undefined,
      prop("Description", g.Description),
      prop("VPC", g.VpcId, true),
      prop("Inbound rules", inbound.length),
      prop("Outbound rules", mine.length - inbound.length),
      open.length ? prop("Open to the internet", open.join(", ")) : undefined,
      cidrIngress.length ? prop("Other sources", cidrIngress.map((x) => x.replace("<-", " ← ")).join(", ")) : undefined,
      input.enis ? prop("Network interfaces", used.length ? `${used.length} (${ownersSummary(used)})` : "none") : prop("Network interfaces", `not read (${enisState})`),
      referencedBy ? prop("Referenced by", [...(refs.get(id) ?? [])].sort().join(", "), true) : undefined,
      isDefault ? prop("Default group", "yes — every VPC has one; it can't be deleted") : undefined,
    );
    return {
      key: arnOf.securityGroup(region, account, id), kind: "security-group", provider: "security-group", name: g.GroupName || id, region, tags,
      health: exposed.length ? "warning" : "ok",
      ...(exposed.length ? { healthReason: `open to the internet on ${exposed.map((e) => (e === "all" ? "all ports" : e)).join(", ")}` } : {}),
      props: p, aliases: [id], ...(g.VpcId ? { vpcId: g.VpcId, parent: arnOf.vpc(region, account, g.VpcId) } : {}),
      consoleUrl: consoleUrl(region, id), facts,
      ...(input.accountId && g.OwnerId && g.OwnerId !== input.accountId ? { account: g.OwnerId } : {}),
      ...(input.now ? { observedAt: input.now } : {}),
      ...(enrichment ? { enrichment } : {}),
    };
  });
  const sgRules = groups.map((g) => groupFacts(g, byGroup.get(g.GroupId!) ?? [], region));
  return { resources, sgRules };
}

// ---------- detail ----------

// A referenced group names its account only when it isn't the console's own (the API always sets UserId).
const sourceOf = (r: Rule, own?: string) =>
  r.cidr ?? r.prefixList ?? (r.group ? `${r.group}${r.groupAccount && r.groupAccount !== own ? ` (account ${r.groupAccount})` : ""}${r.peering ? ` via ${r.peering}` : ""}` : "?");
const portsLabel = (r: Rule) => (r.protocol === "all" ? "all" : !ported(r.protocol) ? "—" : r.fromPort === undefined ? "all" : r.fromPort === r.toPort ? String(r.fromPort) : `${r.fromPort}-${r.toPort}`);

// The panel's rule tables: protocol, ports, source (inbound) or destination (outbound), description.
export function ruleRows(rules: Rule[], egress: boolean, ownAccount?: string): string[][] {
  return rules.filter((r) => r.egress === egress).map((r) => [r.protocol, portsLabel(r), sourceOf(r, ownAccount), r.description ?? ""]);
}
export function eniRows(enis: RawEni[]): string[][] {
  return enis.map((e) => [
    e.NetworkInterfaceId ?? "", eniOwner(e) + (e.Attachment?.InstanceId ? ` ${e.Attachment.InstanceId}` : /^ELB |^ElastiCache /.test(e.Description ?? "") ? ` ${(e.Description ?? "").replace(/^ELB |^ElastiCache /, "")}` : ""),
    e.SubnetId ?? "", [e.PrivateIpAddress, e.Association?.PublicIp].filter(Boolean).join(" · "), e.Status ?? "",
  ]);
}
