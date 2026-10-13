// Security groups provider (audit §6 A.2 #2): every group in the region, with its rules and the network interfaces that
// use it — one DescribeSecurityGroups, DescribeSecurityGroupRules and DescribeNetworkInterfaces pass. Each group gets
// the facts the exposure and unused rules read (propagate.ts R4 / R7: openIngress, cidrIngress, attachments,
// referencedBy, isDefault), a warning when it is open to the internet on anything but 80/443, and its parent VPC. Its
// inbound rules also go out as ProviderResult.sgRules: the inventory's "allowed" edges come from them, so groups are
// read once per build (CC-19). Read-only. The mapping is pure (../../inventory/security-group.ts).
import "server-only";
import { DescribeNetworkInterfacesCommand, DescribeSecurityGroupRulesCommand, DescribeSecurityGroupsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { parseArn } from "../../inventory/arn.ts";
import { eniRows, ruleRows, rulesFromApi, rulesFromPermissions, securityGroupResults, type RawEni, type RawSgRule } from "../../inventory/security-group.ts";
import type { EnrichState, Resource, ResourceDetail } from "../../inventory/types.ts";
import { errText } from "../errors.ts";
import { simSecurityGroups } from "./mock/security-group.ts";
import { paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const ec2 = perRegion((r) => new EC2Client(sdkConfig(r)), "ec2");
// Rules and interfaces are one pass each; past these the pass stops and its facts stay unknown (never "unused").
const RULES_CAP = 20_000;
const ENI_CAP = 10_000;

// Every page of one pass, with how it went: ok, capped (more than `cap`), denied or error (noted once). Never throws
// unless the run's deadline passed.
async function pass<T>(ctx: ProviderContext, label: string, cap: number, page: (token: string | undefined) => Promise<{ items?: T[]; next?: string }>): Promise<{ items?: T[]; state: EnrichState }> {
  const out: T[] = [];
  let token: string | undefined;
  try {
    do {
      const r = await ctx.limit(() => page(token), { service: "ec2" });
      out.push(...(r.items ?? []));
      token = r.next || undefined;
      if (token && out.length >= cap) {
        ctx.note(`${label}: more than ${cap.toLocaleString("en-US")} — not used for the facts`);
        return { state: "capped" };
      }
    } while (token && !ctx.signal.aborted);
  } catch (e) {
    if (ctx.signal.aborted) return { state: "skipped" };
    const denied = deniedAction(e);
    ctx.note(denied ? `${label} skipped: ${denied} denied` : `${label}: ${errText(e)}`);
    return { state: denied ? "denied" : "error" };
  }
  return ctx.signal.aborted ? { state: "skipped" } : { items: out, state: "ok" };
}

// sg id of a group resource (its alias, else the key's last segment).
const groupId = (r: Resource) => r.aliases?.find((a) => a.startsWith("sg-")) ?? parseArn(r.key)?.id ?? r.key;
const regionOf = (r: Resource, ctx: { region: string }) => parseArn(r.key)?.region || ctx.region;

// The map's resources in the group's region that sit in it (best effort: the built map, never a wait for a rebuild).
async function usersOf(id: string, region: string): Promise<Resource[]> {
  try {
    const { getInventory } = await import("../inventory.ts");
    const view = await Promise.race([getInventory(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 1_500).unref?.())]);
    return (view?.resources ?? []).filter((x) => x.securityGroups?.includes(id) && (x.region === region || x.region === "global"));
  } catch {
    return [];
  }
}

export const securityGroupProvider: Provider = {
  id: "security-group",
  label: "Security groups",
  kinds: ["security-group"],
  scope: "regional",
  covers: ["ec2:security-group", "ec2:security-group-rule"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeNetworkInterfaces"],
  async discover(ctx) {
    const now = Date.now();
    const base = { region: ctx.region, accountId: ctx.accountId, now };
    if (ctx.mock) {
      const sim = await simSecurityGroups(ctx.region);
      const r = securityGroupResults({ ...base, groups: sim.groups, rules: sim.rules, enis: sim.enis });
      return { resources: r.resources, links: [], mentions: [], sgRules: r.sgRules };
    }
    const c = ec2(ctx.region);
    const groups = await paged(ctx, "security groups", async (NextToken) => {
      const r = await c.send(new DescribeSecurityGroupsCommand({ MaxResults: 1000, NextToken }), t(ctx));
      return { items: r.SecurityGroups, next: r.NextToken };
    }, { service: "ec2" });
    // R18: the groups with the rules DescribeSecurityGroups already carries; interfaces come next.
    const listed = securityGroupResults({ ...base, groups, rulesState: "skipped", enisState: "skipped" });
    ctx.checkpoint?.({ resources: listed.resources, links: [], mentions: [], sgRules: listed.sgRules });
    const [rules, enis] = await Promise.all([
      pass<RawSgRule>(ctx, "security groups: rules", RULES_CAP, async (NextToken) => {
        const r = await c.send(new DescribeSecurityGroupRulesCommand({ MaxResults: 1000, NextToken }), t(ctx, 10_000));
        return { items: r.SecurityGroupRules, next: r.NextToken };
      }),
      pass<RawEni>(ctx, "security groups: network interfaces", ENI_CAP, async (NextToken) => {
        const r = await c.send(new DescribeNetworkInterfacesCommand({ MaxResults: 1000, NextToken }), t(ctx, 10_000));
        return { items: r.NetworkInterfaces, next: r.NextToken };
      }),
    ]);
    const r = securityGroupResults({ ...base, groups, rules: rules.items, enis: enis.items, rulesState: rules.state, enisState: enis.state });
    return { resources: r.resources, links: [], mentions: [], sgRules: r.sgRules };
  },
  // Inbound and outbound rules, the network interfaces using the group, and the map's resources in it.
  async detail(r, ctx): Promise<ResourceDetail> {
    const id = groupId(r);
    const region = regionOf(r, ctx);
    const notes: string[] = [];
    let rules: ReturnType<typeof rulesFromApi> | undefined;
    let enis: RawEni[] | undefined;
    if (ctx.mock) {
      const sim = await simSecurityGroups(region);
      rules = rulesFromApi(sim.rules.filter((x) => x.GroupId === id));
      enis = sim.enis.filter((e) => e.Groups?.some((g) => g.GroupId === id));
    } else {
      const c = ec2(region);
      const filter = [{ Name: "group-id", Values: [id] }];
      const [a, b] = await Promise.allSettled([
        ctx.limit(() => c.send(new DescribeSecurityGroupRulesCommand({ Filters: filter, MaxResults: 1000 }), t(ctx)), { service: "ec2" }),
        ctx.limit(() => c.send(new DescribeNetworkInterfacesCommand({ Filters: filter, MaxResults: 1000 }), t(ctx)), { service: "ec2" }),
      ]);
      if (a.status === "fulfilled") rules = rulesFromApi(a.value.SecurityGroupRules ?? []);
      else {
        const g = await ctx.limit(() => c.send(new DescribeSecurityGroupsCommand({ GroupIds: [id] }), t(ctx)), { service: "ec2" }).catch(() => undefined);
        rules = g ? rulesFromPermissions(g.SecurityGroups ?? []) : undefined;
        if (!rules) notes.push(`rules: ${deniedAction(a.reason) ? `${deniedAction(a.reason)} denied` : errText(a.reason)}`);
      }
      if (b.status === "fulfilled") enis = b.value.NetworkInterfaces ?? [];
      else notes.push(`network interfaces: ${deniedAction(b.reason) ? `${deniedAction(b.reason)} denied` : errText(b.reason)}`);
    }
    const users = await usersOf(id, region);
    const own = parseArn(r.key)?.account || ctx.accountId;
    return {
      key: r.key,
      sections: [
        ...(rules
          ? [
            { title: "Inbound rules", table: { columns: ["Protocol", "Ports", "Source", "Description"], rows: ruleRows(rules, false, own) }, ...(ruleRows(rules, false).length ? {} : { note: "No inbound rules: nothing can connect in." }) },
            { title: "Outbound rules", table: { columns: ["Protocol", "Ports", "Destination", "Description"], rows: ruleRows(rules, true, own) } },
          ]
          : []),
        ...(enis ? [{ title: "Network interfaces", table: { columns: ["Interface", "Used by", "Subnet", "Address", "Status"], rows: eniRows(enis) }, ...(enis.length ? {} : { note: "No network interface uses this group." }) }] : []),
        ...(users.length ? [{ title: "On the map", table: { columns: ["Name", "Kind", "Environment"], rows: users.map((u) => [u.name, u.kind, u.env ?? "—"]) } }] : []),
        ...(notes.length ? [{ title: "Not loaded", note: notes.join(" · ") }] : []),
      ],
    };
  },
};
