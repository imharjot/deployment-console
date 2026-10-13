// Pure rules behind the real Cloud source (src/lib/server/aws.ts): AWS API responses → the Raw* shapes a Cloud returns,
// and the paging and batching aws.ts runs them with. No AWS SDK import: each input type below is the subset of a
// response these rules read, written structurally, so an SDK v3 output is assignable to it and node:test can feed
// plain fixtures (Acme ones, or read-only CLI JSON with its timestamps parsed into Dates). The simulated account
// (src/lib/server/mock.ts) uses the same helpers where it builds the same shapes.
import { hostsFromEnv } from "./discover.ts";
import type {
  RawCache, RawContainer, RawDb, RawDeployment, RawEvent, RawLb, RawLbRule, RawLbTarget, RawLbTargetGroup, RawRevision, RawSecurityGroup,
  RawService, RawTaggedHost, RawTargetHealth, RawTask, RawTaskDef,
} from "./types.ts";

// ---------- shapes the Cloud contract adds in wave B (re-exported by src/lib/server/sources.ts) ----------

// F58: a load balancer's configuration without health — listeners, rules and target groups. Changes rarely (aws.ts
// caches it 10 min); health comes per target group from Cloud.targetHealth (10 s).
export interface LbConfig extends Omit<RawLb, "targetGroups"> {
  targetGroups: Omit<RawLbTargetGroup, "targets">[];
}
// One target group's health: the counts status.ts reads, plus every target (the load balancer panel lists them).
export type TargetHealthDetail = RawTargetHealth & { targets: RawLbTarget[] };
// R24/F68: whether an image is still in its registry, and the digest its tag points to now.
export interface ImageCheck {
  exists: boolean;
  digest?: string;
}
// CC-20: an ECS service's Application Auto Scaling target. policies are short labels: "target tracking (CPU 60 %)".
export interface ScalableTarget {
  service: string;
  min: number;
  max: number;
  policies: string[];
}

// ---------- small helpers ----------

export const chunk = <T,>(a: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
export const ms = (d?: Date) => (d ? d.getTime() : undefined);
export const lastPart = (arn?: string) => (arn ?? "").split("/").pop() ?? "";
// Drops undefined fields, so optional facts are absent rather than present-and-undefined.
export function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
const uniq = <T,>(a: readonly T[]) => [...new Set(a)];

// fn over items with at most `n` in flight; results keep the input order. The first failure rejects, and no further
// item starts after it.
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(n)), items.length) }, worker));
  return out;
}

// Every page of a token-paged listing, up to maxPages; complete is false when a next token was left unread.
export async function allPages<T>(page: (token?: string) => Promise<{ items: T[]; next?: string }>, maxPages = Infinity): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const r = await page(token);
    items.push(...r.items);
    token = r.next || undefined;
    pages++;
  } while (token && pages < maxPages);
  return { items, complete: !token };
}

export const tagMap = (tags?: { key?: string; value?: string; Key?: string; Value?: string }[]): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((x) => [x.key ?? x.Key ?? "", x.value ?? x.Value ?? ""]).filter(([k]) => k));

// ---------- ECS: task definitions ----------

export interface SdkContainerDef {
  name?: string;
  image?: string;
  essential?: boolean;
  cpu?: number;
  memory?: number;
  memoryReservation?: number;
  portMappings?: { containerPort?: number }[];
  logConfiguration?: { logDriver?: string; options?: Record<string, string> };
  healthCheck?: { command?: string[] };
  environment?: { name?: string; value?: string }[];
}
export interface SdkTaskDef {
  taskDefinitionArn?: string;
  family?: string;
  revision?: number;
  cpu?: string;
  memory?: string;
  runtimePlatform?: { cpuArchitecture?: string };
  networkMode?: string;
  requiresCompatibilities?: string[];
  registeredAt?: Date;
  containerDefinitions?: SdkContainerDef[];
  taskRoleArn?: string;
  executionRoleArn?: string;
  volumes?: { name?: string; efsVolumeConfiguration?: { fileSystemId?: string; authorizationConfig?: { accessPointId?: string } } }[];
}

// "The service" is the essential container with ports (sidecars like log routers or agents usually have none).
export function mainContainer<C extends SdkContainerDef>(defs: C[]): C | undefined {
  return defs.find((d) => d.essential !== false && d.portMappings?.length) ?? defs.find((d) => d.essential !== false) ?? defs[0];
}

export function containerOf(d: SdkContainerDef): RawContainer {
  const lo = d.logConfiguration?.logDriver === "awslogs" ? d.logConfiguration.options : undefined;
  return {
    name: d.name ?? "",
    image: d.image ?? "",
    essential: d.essential !== false,
    ports: (d.portMappings ?? []).map((p) => p.containerPort ?? 0).filter(Boolean),
    logGroup: lo?.["awslogs-group"],
    ...(lo?.["awslogs-region"] ? { logRegion: lo["awslogs-region"] } : {}),
    logStreamPrefix: lo?.["awslogs-stream-prefix"],
    // Values stay here: only the hostnames they mention leave (secrets via valueFrom are never visible to us at all).
    envHosts: hostsFromEnv((d.environment ?? []).map((e) => ({ name: e.name ?? "", value: e.value ?? "" }))),
  };
}

export function taskDefOf(td: SdkTaskDef): RawTaskDef {
  const defs = td.containerDefinitions ?? [];
  const c = mainContainer(defs);
  const volumes = (td.volumes ?? []).filter((v) => v.name).map((v) => {
    const efs = v.efsVolumeConfiguration;
    return efs?.fileSystemId ? { name: v.name!, efs: defined({ fileSystemId: efs.fileSystemId, accessPointId: efs.authorizationConfig?.accessPointId }) } : { name: v.name! };
  });
  return {
    arn: td.taskDefinitionArn!,
    family: td.family!,
    revision: td.revision ?? 0,
    image: c?.image ?? "",
    cpu: td.cpu ?? (c?.cpu ? String(c.cpu) : undefined),
    memory: td.memory ?? (c?.memory ? String(c.memory) : undefined),
    memoryReservation: c?.memoryReservation,
    arch: td.runtimePlatform?.cpuArchitecture === "ARM64" ? "arm64" : undefined,
    networkMode: td.networkMode,
    launchTypes: td.requiresCompatibilities ?? [],
    healthcheck: c?.healthCheck?.command?.join(" "),
    ports: (c?.portMappings ?? []).map((p) => p.containerPort ?? 0).filter(Boolean),
    logGroup: c?.logConfiguration?.options?.["awslogs-group"],
    registeredAt: ms(td.registeredAt),
    containers: defs.map(containerOf),
    main: c?.name ?? "",
    ...defined({ taskRoleArn: td.taskRoleArn, executionRoleArn: td.executionRoleArn }),
    ...(volumes.length ? { volumes } : {}),
  };
}

// A revision as the switch dialog needs it: every container's image, so each essential one can be checked (R24).
export function revisionOf(d: RawTaskDef, status: RawRevision["status"] = "ACTIVE"): RawRevision {
  return {
    arn: d.arn, revision: d.revision, image: d.image, registeredAt: d.registeredAt, status,
    containers: d.containers.map((c) => ({ name: c.name, image: c.image, essential: c.essential })),
  };
}

// ---------- ECS: tasks ----------

export interface SdkTask {
  taskArn?: string;
  taskDefinitionArn?: string;
  group?: string;
  lastStatus?: string;
  desiredStatus?: string;
  healthStatus?: string;
  startedAt?: Date;
  stoppedAt?: Date;
  stoppedReason?: string;
  cpu?: string;
  memory?: string;
  containers?: { name?: string; reason?: string; exitCode?: number; imageDigest?: string; networkInterfaces?: { privateIpv4Address?: string }[] }[];
  attachments?: { type?: string; details?: { name?: string; value?: string }[] }[];
}

// The awsvpc address of a running task: its ENI attachment, else the first container's network interface (F18).
export function taskIpOf(t: SdkTask): string | undefined {
  const eni = (t.attachments ?? []).find((a) => a.type === "ElasticNetworkInterface" || a.type === "eni");
  const fromEni = eni?.details?.find((d) => d.name === "privateIPv4Address")?.value;
  return fromEni || t.containers?.flatMap((c) => c.networkInterfaces ?? []).find((n) => n.privateIpv4Address)?.privateIpv4Address || undefined;
}

export function taskOf(t: SdkTask, td: RawTaskDef | undefined): RawTask {
  const c = t.containers?.find((x) => td?.main && x.name === td.main) ?? t.containers?.[0];
  const digests = Object.fromEntries((t.containers ?? []).filter((x) => x.name && x.imageDigest).map((x) => [x.name!, x.imageDigest!]));
  const health = t.healthStatus === "HEALTHY" || t.healthStatus === "UNHEALTHY" ? t.healthStatus : "UNKNOWN";
  return {
    id: lastPart(t.taskArn),
    taskDefinition: t.taskDefinitionArn ?? "",
    lastStatus: t.lastStatus ?? "UNKNOWN",
    desiredStatus: t.desiredStatus ?? "UNKNOWN",
    health,
    hasHealthcheck: !!td?.healthcheck,
    startedAt: ms(t.startedAt),
    stoppedAt: ms(t.stoppedAt),
    stoppedReason: t.stoppedReason ?? c?.reason,
    exitCode: c?.exitCode,
    cpu: t.cpu,
    memory: t.memory,
    // Only a running task's address names a live endpoint; a stopped task's ENI is gone (or about to be reused).
    ...(t.lastStatus === "RUNNING" && taskIpOf(t) ? { privateIp: taskIpOf(t) } : {}),
    ...(Object.keys(digests).length ? { imageDigests: digests } : {}),
  };
}

export const serviceOfGroup = (group?: string) => (group?.startsWith("service:") ? group.slice(8) : "");

// RUNNING tasks are paged to the end, up to this many pages of 100 (5,000 tasks per cluster). Past it, a service whose
// running count the listing doesn't reach is marked tasksComplete: false instead of looking short of tasks.
export const RUNNING_PAGES_MAX = 50;
export const STOPPED_KEPT = 3; // per service, newest first: enough for "last stop" reasons

export interface TaskReader {
  list(desiredStatus: "RUNNING" | "STOPPED", nextToken?: string): Promise<{ taskArns?: string[]; nextToken?: string }>;
  describe(taskArns: string[]): Promise<SdkTask[]>; // DescribeTasks, at most 100
  taskDef(arn: string): Promise<RawTaskDef>; // memoised by the caller
}
export interface ClusterTasks {
  byService: Map<string, RawTask[]>; // running first (as listed), then the newest STOPPED_KEPT stopped ones
  runningComplete: boolean;
  stoppedComplete: boolean;
}

// A cluster's tasks by service (R13/F29). RUNNING is paged to the end (up to RUNNING_PAGES_MAX). STOPPED is one page on
// purpose: ECS keeps stopped tasks for about an hour, they only explain recent stops, and paging them on a busy cluster
// would cost more calls than that evidence is worth — stoppedComplete says when the page didn't hold them all.
// Describes run `concurrency` at a time; task definitions are fetched once each, after the describes.
export async function clusterTasks(r: TaskReader, o: { concurrency?: number; maxRunningPages?: number } = {}): Promise<ClusterTasks> {
  const concurrency = o.concurrency ?? 4;
  const [running, stopped] = await Promise.all([
    allPages(async (token) => {
      const p = await r.list("RUNNING", token);
      return { items: p.taskArns ?? [], next: p.nextToken };
    }, o.maxRunningPages ?? RUNNING_PAGES_MAX),
    r.list("STOPPED"),
  ]);
  const runArns = uniq(running.items);
  const isRunning = new Set(runArns);
  const stopArns = uniq(stopped.taskArns ?? []).filter((a) => !isRunning.has(a));
  // One pass over both lists, so at most `concurrency` DescribeTasks are in flight for the cluster.
  const described = (await mapLimit(chunk([...runArns, ...stopArns], 100), concurrency, (b) => r.describe(b))).flat();
  const runTasks = described.filter((t) => isRunning.has(t.taskArn ?? ""));
  const all = described.filter((t) => serviceOfGroup(t.group));
  // A running task's definition is needed (health check); a stopped one's is a nicety: one deleted since mustn't fail
  // the whole cluster.
  const needed = new Set(runTasks.map((t) => t.taskDefinitionArn).filter((a): a is string => !!a));
  const tdArns = uniq(all.map((t) => t.taskDefinitionArn).filter((a): a is string => !!a));
  const tds = new Map<string, RawTaskDef | undefined>(
    await mapLimit(tdArns, concurrency, async (a) => [a, needed.has(a) ? await r.taskDef(a) : await r.taskDef(a).catch(() => undefined)] as const),
  );
  const byService = new Map<string, RawTask[]>();
  for (const t of all) {
    const svc = serviceOfGroup(t.group);
    const list = byService.get(svc) ?? [];
    list.push(taskOf(t, t.taskDefinitionArn ? tds.get(t.taskDefinitionArn) : undefined));
    byService.set(svc, list);
  }
  for (const [svc, v] of byService) {
    const run = v.filter((x) => x.desiredStatus === "RUNNING");
    const stop = v.filter((x) => x.desiredStatus !== "RUNNING").sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0)).slice(0, STOPPED_KEPT);
    byService.set(svc, [...run, ...stop]);
  }
  return { byService, runningComplete: running.complete, stoppedComplete: !stopped.nextToken };
}

// ---------- ECS: services ----------

export interface SdkDeployment {
  id?: string;
  status?: string;
  rolloutState?: string;
  rolloutStateReason?: string;
  taskDefinition?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  failedTasks?: number;
  createdAt?: Date;
  updatedAt?: Date;
  serviceConnectConfiguration?: {
    enabled?: boolean;
    services?: { portName?: string; discoveryName?: string; clientAliases?: { port?: number; dnsName?: string }[] }[];
  };
}
export interface SdkService {
  serviceName?: string;
  status?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  launchType?: string;
  capacityProviderStrategy?: { capacityProvider?: string; weight?: number; base?: number }[];
  deployments?: SdkDeployment[];
  loadBalancers?: { targetGroupArn?: string }[];
  deploymentConfiguration?: { deploymentCircuitBreaker?: { enable?: boolean } };
  deploymentController?: { type?: string };
  createdAt?: Date;
  tags?: { key?: string; value?: string }[];
  networkConfiguration?: { awsvpcConfiguration?: { subnets?: string[]; securityGroups?: string[]; assignPublicIp?: string } };
  serviceRegistries?: { registryArn?: string; containerName?: string; containerPort?: number }[];
  events?: { id?: string; createdAt?: Date; message?: string }[];
}

export const eventOf = (e: { id?: string; createdAt?: Date; message?: string }): RawEvent => ({ id: e.id ?? "", at: ms(e.createdAt) ?? 0, message: e.message ?? "" });

function deploymentOf(d: SdkDeployment): RawDeployment {
  return {
    id: d.id ?? "",
    status: (d.status as RawDeployment["status"]) ?? "ACTIVE",
    rolloutState: d.rolloutState as RawDeployment["rolloutState"],
    rolloutReason: d.rolloutStateReason,
    taskDefinition: d.taskDefinition ?? "",
    desired: d.desiredCount ?? 0,
    running: d.runningCount ?? 0,
    pending: d.pendingCount ?? 0,
    failedTasks: d.failedTasks ?? 0,
    createdAt: ms(d.createdAt) ?? 0,
    updatedAt: ms(d.updatedAt) ?? 0,
  };
}

export const primaryTaskDef = (s: SdkService) => s.deployments?.find((d) => d.status === "PRIMARY")?.taskDefinition;

// Service Connect as the PRIMARY deployment configures it (else the newest deployment that has it on): the names
// other services' tasks call this one by. Aliases without a DNS name are left out (ECS derives those itself).
function serviceConnectOf(s: SdkService): RawService["serviceConnect"] {
  const deps = s.deployments ?? [];
  const sc = [deps.find((d) => d.status === "PRIMARY"), ...deps].find((d) => d?.serviceConnectConfiguration?.enabled)?.serviceConnectConfiguration;
  const services = (sc?.services ?? []).map((x) => ({
    ...defined({ discoveryName: x.discoveryName ?? x.portName }),
    clientAliases: (x.clientAliases ?? []).filter((a) => a.dnsName).map((a) => defined({ dnsName: a.dnsName!, port: a.port })),
  }));
  return services.length ? services : undefined;
}

// One DescribeServices entry, its tasks (clusterTasks) and its PRIMARY task definition → RawService. All of the
// service's events are kept (DescribeServices returns at most the newest 100), newest first (F11).
export function serviceOf(cluster: string, s: SdkService, tasks: ClusterTasks, taskDef: RawTaskDef | null): RawService {
  const launch = s.launchType ?? (s.capacityProviderStrategy?.some((c) => c.capacityProvider?.startsWith("FARGATE")) ? "FARGATE" : "EC2");
  const vpc = s.networkConfiguration?.awsvpcConfiguration;
  const mine = tasks.byService.get(s.serviceName ?? "") ?? [];
  const listed = mine.filter((t) => t.desiredStatus === "RUNNING").length;
  const cps = (s.capacityProviderStrategy ?? []).filter((c) => c.capacityProvider).map((c) => defined({ provider: c.capacityProvider!, weight: c.weight, base: c.base }));
  const registries = (s.serviceRegistries ?? []).filter((r) => r.registryArn).map((r) => defined({ registryArn: r.registryArn!, containerName: r.containerName, containerPort: r.containerPort }));
  return {
    name: s.serviceName!,
    cluster,
    status: s.status ?? "UNKNOWN",
    desired: s.desiredCount ?? 0,
    running: s.runningCount ?? 0,
    pending: s.pendingCount ?? 0,
    launchType: launch === "FARGATE" ? "FARGATE" : launch === "EC2" ? "EC2" : "UNKNOWN",
    deployments: (s.deployments ?? []).map(deploymentOf),
    tasks: mine,
    taskDef,
    targetGroupArns: (s.loadBalancers ?? []).map((l) => l.targetGroupArn!).filter(Boolean),
    circuitBreaker: !!s.deploymentConfiguration?.deploymentCircuitBreaker?.enable,
    createdAt: ms(s.createdAt),
    tags: tagMap(s.tags),
    securityGroups: vpc?.securityGroups ?? [],
    subnets: vpc?.subnets ?? [],
    events: (s.events ?? []).map(eventOf),
    deploymentController: s.deploymentController?.type ?? "ECS",
    ...(registries.length ? { serviceRegistries: registries } : {}),
    ...(cps.length ? { capacityProviderStrategy: cps } : {}),
    ...(vpc ? { assignPublicIp: vpc.assignPublicIp === "ENABLED" } : {}),
    ...defined({ serviceConnect: serviceConnectOf(s) }),
    tasksComplete: tasks.runningComplete || listed >= (s.runningCount ?? 0) + (s.pendingCount ?? 0),
    stoppedComplete: tasks.stoppedComplete,
  };
}

// ---------- RDS ----------

export interface SdkDbInstance {
  DBInstanceIdentifier?: string;
  DBInstanceStatus?: string;
  Engine?: string;
  EngineVersion?: string;
  DBInstanceClass?: string;
  AllocatedStorage?: number;
  MultiAZ?: boolean;
  Endpoint?: { Address?: string; Port?: number };
  DBSubnetGroup?: { DBSubnetGroupName?: string; VpcId?: string; Subnets?: { SubnetIdentifier?: string }[] };
  PreferredMaintenanceWindow?: string;
  OptionGroupMemberships?: { OptionGroupName?: string }[];
  VpcSecurityGroups?: { VpcSecurityGroupId?: string }[];
  TagList?: { Key?: string; Value?: string }[];
  DBClusterIdentifier?: string;
  KmsKeyId?: string;
  PubliclyAccessible?: boolean;
  CACertificateIdentifier?: string;
  CertificateDetails?: { CAIdentifier?: string; ValidTill?: Date };
  InstanceCreateTime?: Date;
  StorageEncrypted?: boolean;
  BackupRetentionPeriod?: number;
  DeletionProtection?: boolean;
  PreferredBackupWindow?: string;
  DBParameterGroups?: { DBParameterGroupName?: string }[];
}

// Everything DescribeDBInstances says about posture (F16): public access, encryption, backups, deletion protection,
// the CA and its expiry. The instance's tags come with it (TagList).
export function dbOf(d: SdkDbInstance): RawDb {
  const subnets = (d.DBSubnetGroup?.Subnets ?? []).map((s) => s.SubnetIdentifier!).filter(Boolean);
  return {
    id: d.DBInstanceIdentifier!, status: d.DBInstanceStatus ?? "unknown", engine: d.Engine ?? "", engineVersion: d.EngineVersion ?? "",
    instanceClass: d.DBInstanceClass ?? "", storageGb: d.AllocatedStorage ?? 0, multiAz: !!d.MultiAZ, endpoint: d.Endpoint?.Address,
    port: d.Endpoint?.Port, vpcId: d.DBSubnetGroup?.VpcId, securityGroups: (d.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId!).filter(Boolean),
    tags: tagMap(d.TagList), aurora: d.DBClusterIdentifier,
    ...defined({
      kmsKeyId: d.KmsKeyId,
      publiclyAccessible: d.PubliclyAccessible,
      subnetIds: subnets.length ? subnets : undefined,
      caCertificate: d.CertificateDetails?.CAIdentifier ?? d.CACertificateIdentifier,
      caValidTill: ms(d.CertificateDetails?.ValidTill),
      createdAt: ms(d.InstanceCreateTime),
      storageEncrypted: d.StorageEncrypted,
      backupRetentionDays: d.BackupRetentionPeriod,
      deletionProtection: d.DeletionProtection,
      backupWindow: d.PreferredBackupWindow,
      parameterGroup: d.DBParameterGroups?.[0]?.DBParameterGroupName,
      maintenanceWindow: d.PreferredMaintenanceWindow,
      optionGroup: d.OptionGroupMemberships?.[0]?.OptionGroupName,
      subnetGroup: d.DBSubnetGroup?.DBSubnetGroupName,
    }),
  };
}

// ---------- ElastiCache ----------

type Endpoint = { Address?: string; Port?: number };
export interface SdkReplicationGroup {
  ReplicationGroupId?: string;
  ARN?: string;
  Status?: string;
  Engine?: string;
  CacheNodeType?: string;
  MemberClusters?: string[];
  ConfigurationEndpoint?: Endpoint;
  NodeGroups?: { PrimaryEndpoint?: Endpoint }[];
  KmsKeyId?: string;
  ReplicationGroupCreateTime?: Date;
  TransitEncryptionEnabled?: boolean;
  AtRestEncryptionEnabled?: boolean;
  AuthTokenEnabled?: boolean;
  SnapshotRetentionLimit?: number;
  SnapshotWindow?: string;
  AutomaticFailover?: string;
  MultiAZ?: string;
}
export interface SdkCacheCluster {
  CacheClusterId?: string;
  ARN?: string;
  ReplicationGroupId?: string;
  CacheClusterStatus?: string;
  Engine?: string;
  EngineVersion?: string;
  CacheNodeType?: string;
  NumCacheNodes?: number;
  ConfigurationEndpoint?: Endpoint;
  CacheNodes?: { Endpoint?: Endpoint }[];
  SecurityGroups?: { SecurityGroupId?: string }[];
  CacheSubnetGroupName?: string;
  CacheClusterCreateTime?: Date;
  TransitEncryptionEnabled?: boolean;
  AtRestEncryptionEnabled?: boolean;
  AuthTokenEnabled?: boolean;
  SnapshotRetentionLimit?: number;
  SnapshotWindow?: string;
  PreferredMaintenanceWindow?: string;
  CacheParameterGroup?: { CacheParameterGroupName?: string };
}

// Replication groups (their member clusters give the engine version, security groups and subnet group), then the
// standalone clusters (memcached, or Redis without a group). VPC, subnets and tags need calls aws.ts doesn't make
// (DescribeCacheSubnetGroups, ListTagsForResource): the elasticache provider adds them.
export function cachesOf(groups: SdkReplicationGroup[], clusters: SdkCacheCluster[]): RawCache[] {
  const byId = new Map(clusters.map((c) => [c.CacheClusterId ?? "", c]));
  const out: RawCache[] = groups.map((g) => {
    const ep = g.ConfigurationEndpoint ?? g.NodeGroups?.[0]?.PrimaryEndpoint;
    const members = (g.MemberClusters ?? []).map((id) => byId.get(id)).filter((c): c is SdkCacheCluster => !!c);
    const first = members[0];
    return {
      id: g.ReplicationGroupId!, status: g.Status ?? "unknown", engine: g.Engine ?? first?.Engine ?? "redis", nodeType: g.CacheNodeType,
      nodes: g.MemberClusters?.length ?? 0, endpoint: ep?.Address, port: ep?.Port,
      securityGroups: uniq(members.flatMap((c) => (c.SecurityGroups ?? []).map((x) => x.SecurityGroupId!).filter(Boolean))),
      ...defined({
        engineVersion: first?.EngineVersion,
        arn: g.ARN,
        kmsKeyId: g.KmsKeyId,
        memberClusters: g.MemberClusters?.length ? [...g.MemberClusters] : undefined,
        subnetGroup: first?.CacheSubnetGroupName,
        createdAt: ms(g.ReplicationGroupCreateTime) ?? ms(first?.CacheClusterCreateTime),
        transitEncryption: g.TransitEncryptionEnabled,
        atRestEncryption: g.AtRestEncryptionEnabled,
        authToken: g.AuthTokenEnabled,
        snapshotRetentionDays: g.SnapshotRetentionLimit ?? first?.SnapshotRetentionLimit,
        snapshotWindow: g.SnapshotWindow ?? first?.SnapshotWindow,
        maintenanceWindow: first?.PreferredMaintenanceWindow,
        parameterGroup: first?.CacheParameterGroup?.CacheParameterGroupName,
        automaticFailover: g.AutomaticFailover,
        multiAz: g.MultiAZ === undefined ? undefined : g.MultiAZ === "enabled",
      }),
    };
  });
  for (const c of clusters.filter((x) => !x.ReplicationGroupId)) {
    const ep = c.ConfigurationEndpoint ?? c.CacheNodes?.[0]?.Endpoint;
    out.push({
      id: c.CacheClusterId!, status: c.CacheClusterStatus ?? "unknown", engine: c.Engine ?? "", nodeType: c.CacheNodeType,
      nodes: c.NumCacheNodes ?? 0, endpoint: ep?.Address, port: ep?.Port, securityGroups: (c.SecurityGroups ?? []).map((g) => g.SecurityGroupId!).filter(Boolean),
      ...defined({
        engineVersion: c.EngineVersion,
        arn: c.ARN,
        subnetGroup: c.CacheSubnetGroupName,
        createdAt: ms(c.CacheClusterCreateTime),
        transitEncryption: c.TransitEncryptionEnabled,
        atRestEncryption: c.AtRestEncryptionEnabled,
        authToken: c.AuthTokenEnabled,
        snapshotRetentionDays: c.SnapshotRetentionLimit,
        snapshotWindow: c.SnapshotWindow,
        maintenanceWindow: c.PreferredMaintenanceWindow,
        parameterGroup: c.CacheParameterGroup?.CacheParameterGroupName,
      }),
    });
  }
  return out;
}

// ---------- EC2 ----------

export interface SdkSecurityGroup {
  GroupId?: string;
  GroupName?: string;
  VpcId?: string;
  IpPermissions?: {
    FromPort?: number;
    ToPort?: number;
    UserIdGroupPairs?: { GroupId?: string; Description?: string }[];
    IpRanges?: { CidrIp?: string; Description?: string }[];
    Ipv6Ranges?: { CidrIpv6?: string; Description?: string }[];
    PrefixListIds?: { PrefixListId?: string; Description?: string }[];
  }[];
}

// Inbound rules with their sources: other groups, IPv4 and IPv6 ranges, prefix lists, and the first description.
export function securityGroupOf(g: SdkSecurityGroup): RawSecurityGroup {
  return {
    id: g.GroupId!, name: g.GroupName ?? "", vpcId: g.VpcId,
    inbound: (g.IpPermissions ?? []).map((p) => {
      const cidrs = [...(p.IpRanges ?? []).map((r) => r.CidrIp), ...(p.Ipv6Ranges ?? []).map((r) => r.CidrIpv6)].filter((x): x is string => !!x);
      const prefixLists = (p.PrefixListIds ?? []).map((x) => x.PrefixListId).filter((x): x is string => !!x);
      const description = [...(p.UserIdGroupPairs ?? []), ...(p.IpRanges ?? []), ...(p.Ipv6Ranges ?? []), ...(p.PrefixListIds ?? [])].map((x) => x.Description).find((d) => d);
      return {
        fromPort: p.FromPort, toPort: p.ToPort, groups: (p.UserIdGroupPairs ?? []).map((x) => x.GroupId!).filter(Boolean),
        ...(cidrs.length ? { cidrs } : {}), ...(prefixLists.length ? { prefixLists } : {}), ...defined({ description }),
      };
    }),
  };
}

// R23: EC2 instances the console launched for a cluster, before (and after) they join it.
export const taggedHostFilters = (cluster: string) => [
  { Name: "tag:console:created", Values: ["true"] },
  { Name: "tag:console:cluster", Values: [cluster] },
  { Name: "instance-state-name", Values: ["pending", "running"] },
];
export const taggedHostOf = (i: { InstanceId?: string; State?: { Name?: string }; LaunchTime?: Date }): RawTaggedHost =>
  defined({ id: i.InstanceId ?? "", state: i.State?.Name ?? "unknown", launchedAt: ms(i.LaunchTime) });

// ---------- Elastic Load Balancing ----------

export interface SdkTargetHealthDescription {
  Target?: { Id?: string; Port?: number; AvailabilityZone?: string };
  TargetHealth?: { State?: string; Reason?: string; Description?: string };
}

// Counts by state, as status.ts reads them: registering (initial) and draining targets are neither healthy nor
// unhealthy; unused and unavailable ones count as unhealthy (they serve nothing). Reasons are the unhealthy ones'.
export function healthOf(arn: string, targets: RawLbTarget[]): TargetHealthDetail {
  const n = (s: string) => targets.filter((t) => t.state === s).length;
  const healthy = n("healthy");
  const initial = n("initial");
  const draining = n("draining");
  const bad = targets.filter((t) => !["healthy", "initial", "draining"].includes(t.state));
  return { targetGroupArn: arn, healthy, unhealthy: bad.length, initial, draining, reasons: uniq(bad.map((t) => t.reason).filter((r): r is string => !!r)), targets };
}

export function targetHealthOf(arn: string, d: SdkTargetHealthDescription[]): TargetHealthDetail {
  return healthOf(
    arn,
    d.map((x) => defined({
      id: x.Target?.Id ?? "", port: x.Target?.Port, az: x.Target?.AvailabilityZone, state: x.TargetHealth?.State ?? "unknown",
      reason: x.TargetHealth?.Reason ? String(x.TargetHealth.Reason) : undefined, description: x.TargetHealth?.Description,
    })),
  );
}

export interface SdkLoadBalancer {
  LoadBalancerArn?: string;
  LoadBalancerName?: string;
  DNSName?: string;
  Scheme?: string;
  Type?: string;
  State?: { Code?: string };
  AvailabilityZones?: { ZoneName?: string }[];
  CreatedTime?: Date;
}
export interface SdkRule {
  Priority?: string;
  Conditions?: { Field?: string; Values?: string[]; HostHeaderConfig?: { Values?: string[] }; PathPatternConfig?: { Values?: string[] } }[];
  Actions?: { Type?: string; TargetGroupArn?: string; ForwardConfig?: { TargetGroups?: { TargetGroupArn?: string }[] } }[];
}
export interface SdkTargetGroup {
  TargetGroupArn?: string;
  TargetGroupName?: string;
  Port?: number;
  Protocol?: string;
  HealthCheckPath?: string;
  HealthCheckIntervalSeconds?: number;
  HealthyThresholdCount?: number;
  UnhealthyThresholdCount?: number;
  Matcher?: { HttpCode?: string };
  LoadBalancerArns?: string[];
}

export function ruleOf(r: SdkRule): RawLbRule {
  const cond = (field: string) => (r.Conditions ?? []).filter((c) => c.Field === field).flatMap((c) => c.HostHeaderConfig?.Values ?? c.PathPatternConfig?.Values ?? c.Values ?? []);
  const acts = r.Actions ?? [];
  const fwd = acts.find((a) => a.Type === "forward");
  const kind = acts.map((a) => a.Type).filter(Boolean).join("+") || "none";
  return { priority: r.Priority ?? "", hosts: cond("host-header"), paths: cond("path-pattern"), action: kind, targetGroupArn: fwd?.TargetGroupArn ?? fwd?.ForwardConfig?.TargetGroups?.[0]?.TargetGroupArn };
}

export function lbConfigOf(lb: SdkLoadBalancer, listeners: { port?: number; protocol?: string; rules: SdkRule[] }[], groups: SdkTargetGroup[]): LbConfig {
  return {
    arn: lb.LoadBalancerArn ?? "", name: lb.LoadBalancerName ?? "", dns: lb.DNSName ?? "", scheme: lb.Scheme ?? "", type: lb.Type ?? "", state: lb.State?.Code ?? "unknown",
    azs: (lb.AvailabilityZones ?? []).map((z) => z.ZoneName ?? "").filter(Boolean), createdAt: ms(lb.CreatedTime),
    listeners: listeners.map((l) => ({ port: l.port ?? 0, protocol: l.protocol ?? "", rules: l.rules.map(ruleOf) })).sort((a, b) => b.port - a.port),
    targetGroups: groups.map((g) => ({
      arn: g.TargetGroupArn!, name: g.TargetGroupName ?? "", port: g.Port, protocol: g.Protocol, healthPath: g.HealthCheckPath,
      healthInterval: g.HealthCheckIntervalSeconds, healthyThreshold: g.HealthyThresholdCount, unhealthyThreshold: g.UnhealthyThresholdCount, matcher: g.Matcher?.HttpCode,
    })),
  };
}

// ---------- Application Auto Scaling (CC-20) ----------

export const ECS_DIMENSION = "ecs:service:DesiredCount";
export const ecsResourceId = (cluster: string, service: string) => `service/${cluster}/${service}`;
export const SCALABLE_BATCH = 50; // DescribeScalableTargets takes at most 50 ResourceIds

export interface SdkScalableTarget {
  ResourceId?: string;
  ScalableDimension?: string;
  MinCapacity?: number;
  MaxCapacity?: number;
}
export interface SdkScalingPolicy {
  PolicyName?: string;
  PolicyType?: string;
  ResourceId?: string;
  ScalableDimension?: string;
  TargetTrackingScalingPolicyConfiguration?: {
    TargetValue?: number;
    PredefinedMetricSpecification?: { PredefinedMetricType?: string };
    CustomizedMetricSpecification?: { MetricName?: string };
  };
}

const TRACKED: Record<string, { label: string; unit: string }> = {
  ECSServiceAverageCPUUtilization: { label: "CPU", unit: " %" },
  ECSServiceAverageMemoryUtilization: { label: "memory", unit: " %" },
  ALBRequestCountPerTarget: { label: "requests per target", unit: "" },
};

// "target tracking (CPU 60 %)", "step scaling (acme-api-burst)", "predictive scaling (…)".
export function policyLabel(p: SdkScalingPolicy): string {
  const name = p.PolicyName ?? "unnamed";
  if (p.PolicyType === "TargetTrackingScaling") {
    const c = p.TargetTrackingScalingPolicyConfiguration;
    const type = c?.PredefinedMetricSpecification?.PredefinedMetricType ?? "";
    const known = Object.hasOwn(TRACKED, type) ? TRACKED[type] : undefined;
    const metric = known?.label ?? c?.CustomizedMetricSpecification?.MetricName ?? (type || "custom metric");
    const target = c?.TargetValue === undefined ? "" : ` ${Number(c.TargetValue.toFixed(2))}${known?.unit ?? ""}`;
    return `target tracking (${metric}${target})`;
  }
  if (p.PolicyType === "StepScaling") return `step scaling (${name})`;
  if (p.PolicyType === "PredictiveScaling") return `predictive scaling (${name})`;
  return `${p.PolicyType ?? "policy"} (${name})`;
}

// The cluster's services that Application Auto Scaling manages (desired count only), with their policies' labels.
export function scalableTargetsOf(cluster: string, targets: SdkScalableTarget[], policies: SdkScalingPolicy[]): ScalableTarget[] {
  const prefix = `service/${cluster}/`;
  return targets
    .filter((t) => t.ResourceId?.startsWith(prefix) && (t.ScalableDimension ?? ECS_DIMENSION) === ECS_DIMENSION)
    .map((t) => ({
      service: t.ResourceId!.slice(prefix.length),
      min: t.MinCapacity ?? 0,
      max: t.MaxCapacity ?? 0,
      policies: policies.filter((p) => p.ResourceId === t.ResourceId && (p.ScalableDimension ?? ECS_DIMENSION) === ECS_DIMENSION).map(policyLabel).sort(),
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

// ---------- CloudWatch GetMetricData pages ----------

export interface SdkMetricResult {
  Id?: string;
  Timestamps?: Date[];
  Values?: number[];
  StatusCode?: string;
}
// Appends one page (a NextToken page continues the same series); `status` keeps each series' last StatusCode.
export function appendMetrics(out: Record<string, [number, number][]>, status: Map<string, string>, results: SdkMetricResult[]): void {
  for (const m of results) {
    if (!m.Id) continue;
    const pts = (m.Timestamps ?? []).map((ts, i): [number, number] => [ts.getTime(), m.Values?.[i] ?? 0]);
    out[m.Id] = [...(out[m.Id] ?? []), ...pts];
    status.set(m.Id, m.StatusCode ?? "");
  }
}

// ---------- IAM policy simulation (F06) ----------

export type SimDecision = "allowed" | "implicitDeny" | "explicitDeny";
export function decisionsOf(results: { EvalActionName?: string; EvalDecision?: string }[]): Record<string, SimDecision> {
  const out: Record<string, SimDecision> = {};
  for (const r of results) {
    const d = r.EvalDecision;
    if (r.EvalActionName && (d === "allowed" || d === "implicitDeny" || d === "explicitDeny")) out[r.EvalActionName] = d;
  }
  return out;
}

// ---------- ECR (R24, F68) ----------

const REGION_CODE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const ECR_REGISTRY = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/;

// Where an image lives in ECR. `repository` is a repository name in this account and region ("acme/storefront-api"),
// or registry-qualified ("123456789012.dkr.ecr.eu-west-1.amazonaws.com/acme/storefront-api", tag or digest allowed).
// null: a registry that isn't ECR (Docker Hub, ghcr.io…) — nothing here can check it.
export function ecrTarget(repository: string, region: string): { repositoryName: string; registryId?: string; region: string; tag?: string; digest?: string } | null {
  const [nameTag, digest] = repository.trim().split("@");
  const slash = nameTag.indexOf("/");
  const first = slash > 0 ? nameTag.slice(0, slash) : "";
  const hasRegistry = /[.:]/.test(first) || first === "localhost";
  let rest = nameTag;
  let where: { registryId?: string; region: string } = { region };
  if (hasRegistry) {
    const m = ECR_REGISTRY.exec(first);
    if (!m || !REGION_CODE.test(m[2])) return null;
    where = { registryId: m[1], region: m[2] };
    rest = nameTag.slice(slash + 1);
  }
  const colon = rest.lastIndexOf(":");
  const repositoryName = colon > 0 && !rest.slice(colon).includes("/") ? rest.slice(0, colon) : rest;
  const tag = repositoryName !== rest ? rest.slice(colon + 1) : undefined;
  if (!repositoryName) return null;
  return { repositoryName, ...where, ...defined({ tag, digest }) };
}

// ---------- writes (F31, R05) ----------

// RunTask and RunInstances take at most 64 printable ASCII characters. A longer key keeps its start and gets a hash of
// the whole, so distinct keys stay distinct and the same key always gives the same token.
export function clientToken(raw: string, max = 64): string {
  const clean = raw.replace(/[^\x21-\x7e]/g, "-");
  if (clean.length <= max) return clean;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < raw.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(raw.charCodeAt(i))) * 0x100000001b3n);
  const hex = h.toString(16).padStart(16, "0");
  return `${clean.slice(0, max - hex.length - 1)}-${hex}`;
}

export const ENV_FILE_CHANGED = "env file changed since it was read — reload and apply your change again";
export const SECRET_CHANGED = "secret changed since it was read — reload and apply your change again";

// S3's answer to a conditional write that lost: 412 PreconditionFailed (the ETag moved), or 409
// ConditionalRequestConflict (another conditional write to the same key was in flight).
export function isPreconditionFailed(e: unknown): boolean {
  const err = e as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } } | undefined;
  const name = String(err?.name ?? err?.Code ?? "");
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || err?.$metadata?.httpStatusCode === 412;
}

// The Secrets Manager version a stage (AWSCURRENT by default) points to, from DescribeSecret's VersionIdsToStages.
export function versionWithStage(map: Record<string, string[]> | undefined, stage = "AWSCURRENT"): string | undefined {
  return Object.entries(map ?? {}).find(([, stages]) => stages.includes(stage))?.[0];
}
