// EFS provider: file systems with their mount targets (VPC, subnets, security groups, addresses) and access points.
// Lists DescribeFileSystems and DescribeAccessPoints (100 per page), hands that to ctx.checkpoint, then reads per item
// through enrich() (R18): DescribeMountTargets per file system and DescribeMountTargetSecurityGroups per mount target,
// the first 300 of each (the latter is also authorised by ec2:DescribeNetworkInterfaceAttribute on the mount target's
// network interface — declared as implicit). Tags come with the listing. Activity: client connections (required, R20).
// The ECS side draws the "mounts" links from task definitions' EFS volumes. Read-only: no actions. The mapping is pure
// (../../inventory/efs.ts).
import "server-only";
import { DescribeAccessPointsCommand, DescribeFileSystemsCommand, DescribeMountTargetSecurityGroupsCommand, DescribeMountTargetsCommand, EFSClient } from "@aws-sdk/client-efs";
import { parseArn } from "../../inventory/arn.ts";
import { efsDetail, efsResult, type RawAccessPoint, type RawFileSystem, type RawMountTarget } from "../../inventory/efs.ts";
import type { EnrichState } from "../../inventory/types.ts";
import { errText } from "../errors.ts";
import { simAccessPoints, simFileSystems, simLastClient } from "./mock/efs.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const efs = perRegion((region) => new EFSClient(sdkConfig(region)), "elasticfilesystem");
const PAGE = 100;
const MOUNT_TARGETS_MAX = 300; // file systems whose mount targets are read
const GROUPS_MAX = 300; // mount targets whose security groups are read

const listFileSystems = (ctx: ProviderContext, region: string, id?: string) =>
  paged(ctx, "efs file systems", async (Marker) => {
    const r = await efs(region).send(new DescribeFileSystemsCommand({ ...(id ? { FileSystemId: id } : { MaxItems: PAGE }), Marker }), t(ctx));
    return { items: r.FileSystems as RawFileSystem[] | undefined, next: r.NextMarker };
  }, { service: "elasticfilesystem" });

// Access points are aliases of their file systems; a failed read is noted and leaves them out, the state says why.
async function listAccessPoints(ctx: ProviderContext, region: string, fileSystemId?: string): Promise<{ items?: RawAccessPoint[]; state: EnrichState }> {
  try {
    const items = await paged(ctx, "efs access points", async (NextToken) => {
      const r = await efs(region).send(new DescribeAccessPointsCommand({ ...(fileSystemId ? { FileSystemId: fileSystemId } : {}), MaxResults: PAGE, NextToken }), t(ctx));
      return { items: r.AccessPoints as RawAccessPoint[] | undefined, next: r.NextToken };
    }, { service: "elasticfilesystem" });
    return { items, state: "ok" };
  } catch (e) {
    if (ctx.signal.aborted) return { state: "skipped" };
    const action = deniedAction(e);
    ctx.note(action ? `efs access points skipped: ${action} denied` : `efs access points: ${errText(e)}`);
    return { state: action ? "denied" : "error" };
  }
}

async function mountTargetsOf(ctx: ProviderContext, region: string, fileSystemId: string): Promise<RawMountTarget[]> {
  const out: RawMountTarget[] = [];
  let Marker: string | undefined;
  do {
    const r = await efs(region).send(new DescribeMountTargetsCommand({ FileSystemId: fileSystemId, MaxItems: PAGE, Marker }), t(ctx));
    out.push(...((r.MountTargets ?? []) as RawMountTarget[]));
    Marker = r.NextMarker || undefined;
  } while (Marker && !ctx.signal.aborted);
  return out;
}

const groupsOf = async (ctx: ProviderContext, region: string, mountTargetId: string) =>
  (await efs(region).send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: mountTargetId }), t(ctx))).SecurityGroups ?? [];

async function fetchEfs(ctx: ProviderContext): Promise<{ fileSystems: RawFileSystem[]; accessPoints?: RawAccessPoint[] }> {
  const region = ctx.region;
  const [listed, aps] = await Promise.all([listFileSystems(ctx, region), listAccessPoints(ctx, region)]);
  const base = listed.map((f): RawFileSystem => ({ ...f, enrichment: { "mount targets": "skipped", ...(aps.state !== "ok" ? { "access points": aps.state } : {}) } }));
  ctx.checkpoint?.(efsResult({ fileSystems: base, accessPoints: aps.items }, { region, account: ctx.accountId, now: Date.now() }));
  const until = budget();
  const mt = await enrich(ctx, base, { label: "efs mount targets", max: MOUNT_TARGETS_MAX, until }, (f) => mountTargetsOf(ctx, region, f.FileSystemId!));
  const all = mt.results.flatMap((l) => l ?? []);
  const sg = await enrich(ctx, all, { label: "efs mount target security groups", max: GROUPS_MAX, until }, (m) => groupsOf(ctx, region, m.MountTargetId!));
  const groupsByTarget = new Map(all.map((m, i) => [m, { groups: sg.results[i], state: sg.state[i] }]));
  const fileSystems = base.map((f, i): RawFileSystem => {
    const targets = mt.state[i] === "ok" ? (mt.results[i] ?? []) : undefined;
    const states = (targets ?? []).map((m) => groupsByTarget.get(m)?.state).filter((s): s is EnrichState => !!s);
    const worst = states.find((s) => s !== "ok");
    return {
      ...f,
      ...(targets ? { mountTargets: targets.map((m) => ({ ...m, ...(groupsByTarget.get(m)?.state === "ok" ? { securityGroups: groupsByTarget.get(m)?.groups ?? [] } : {}) })) } : {}),
      enrichment: { ...f.enrichment, "mount targets": mt.state[i], ...(targets?.length ? { "mount target security groups": worst ?? "ok" } : {}) },
    };
  });
  return { fileSystems, accessPoints: aps.items };
}

export const efsProvider: Provider = {
  id: "efs",
  label: "EFS",
  kinds: ["efs-filesystem"],
  scope: "regional",
  covers: ["elasticfilesystem:file-system", "elasticfilesystem:access-point"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["elasticfilesystem:DescribeFileSystems", "elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeMountTargetSecurityGroups", "elasticfilesystem:DescribeAccessPoints"],
  // DescribeMountTargetSecurityGroups also needs this on the mount target's network interface.
  implicit: ["ec2:DescribeNetworkInterfaceAttribute"],
  async discover(ctx) {
    const o = { region: ctx.region, account: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const out = efsResult({ fileSystems: simFileSystems(ctx.region), accessPoints: simAccessPoints(ctx.region) }, o);
      for (const r of out.resources) r.lastActivityAt = simLastClient();
      return out;
    }
    return efsResult(await fetchEfs(ctx), o);
  },
  // A.2 #14: AWS/EFS ClientConnections per FileSystemId, summed (R20: the series that shows use).
  activity: (r) => {
    const p = parseArn(r.key);
    const FileSystemId = p?.id || r.aliases?.[0] || "";
    return [{ namespace: "AWS/EFS", metric: "ClientConnections", dims: { FileSystemId }, stat: "Sum", label: "client connections per day (idle check)", region: p?.region || undefined, required: true }];
  },
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    const id = parseArn(r.key)?.id ?? "";
    if (ctx.mock) return efsDetail(r.key, simFileSystems(region).find((f) => f.FileSystemId === id), simAccessPoints(region), region);
    let f: RawFileSystem | undefined;
    try {
      f = (await listFileSystems(ctx, region, id))[0];
    } catch (e) {
      if (!/NotFound/.test((e as { name?: string })?.name ?? "")) throw e;
    }
    if (!f) return efsDetail(r.key, undefined, undefined, region);
    const [targets, aps] = await Promise.all([softly(ctx, "efs mount targets", { service: "elasticfilesystem" })(() => mountTargetsOf(ctx, region, id)), listAccessPoints(ctx, region, id)]);
    const withGroups = targets
      ? await Promise.all(targets.map(async (m) => {
          const groups = await softly(ctx, "efs mount target security groups", { service: "elasticfilesystem" })(() => groupsOf(ctx, region, m.MountTargetId!));
          return { ...m, ...(groups ? { securityGroups: groups } : {}) };
        }))
      : undefined;
    return efsDetail(r.key, { ...f, ...(withGroups ? { mountTargets: withGroups } : {}), enrichment: { "mount targets": withGroups ? "ok" : "error" } }, aps.items, region);
  },
};
