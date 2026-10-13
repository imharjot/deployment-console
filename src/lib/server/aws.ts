// Real Cloud source: AWS SDK v3 with the ECS task role's credentials (no keys anywhere). One Cloud per region
// (awsCloud(region), kept by getCloud in sources.ts), each with its own clients.
// Every read carries a 5s abort; SDK retries use adaptive mode so ECS/Logs throttling backs off instead of failing; every
// client goes through the console's SDK-call limiter (aws-limiter.ts: per service × region, then a global cap).
// Writes (F31) go through separate clients that never retry, with LIMITS.awsWriteTimeoutMs: a retry after a lost answer
// could run a change twice, or fail a conditional write (S3 If-Match) on the change it made itself. A write cut off
// after it was sent throws OutcomeUnknownError instead — the operation is recorded as outcome unknown.
// The response → Raw* mapping is pure and tested: src/lib/aws-mapping.ts.
import {
  CreateServiceCommand, DeleteServiceCommand, DescribeClustersCommand, DescribeContainerInstancesCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand,
  DescribeTasksCommand, ECSClient, ListClustersCommand, ListContainerInstancesCommand, ListServicesCommand, ListTaskDefinitionsCommand, ListTasksCommand,
  RegisterTaskDefinitionCommand, RunTaskCommand, UpdateServiceCommand, type ContainerDefinition, type LaunchType, type PlacementConstraintType,
  type PlacementStrategyType, type RegisterTaskDefinitionCommandInput, type Tag, type TaskDefinition,
} from "@aws-sdk/client-ecs";
import { DescribeParametersCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import {
  CloudWatchLogsClient, DescribeLogStreamsCommand, FilterLogEventsCommand, GetLogEventsCommand, GetQueryResultsCommand, StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  DescribeInstanceAttributeCommand, DescribeInstancesCommand, DescribeRegionsCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand, EC2Client, RunInstancesCommand,
  StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand, type Instance, type RunInstancesCommandInput, type _InstanceType,
} from "@aws-sdk/client-ec2";
import { DescribeDBInstancesCommand, RDSClient, StartDBInstanceCommand, StopDBInstanceCommand } from "@aws-sdk/client-rds";
import { DescribeCacheClustersCommand, DescribeReplicationGroupsCommand, ElastiCacheClient } from "@aws-sdk/client-elasticache";
import {
  DescribeListenersCommand, DescribeLoadBalancersCommand, DescribeRulesCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { ApplicationAutoScalingClient, DescribeScalableTargetsCommand, DescribeScalingPoliciesCommand } from "@aws-sdk/client-application-auto-scaling";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import {
  allPages, appendMetrics, cachesOf, chunk, clientToken, clusterTasks, dbOf, decisionsOf, ECS_DIMENSION, ecrTarget, ecsResourceId, ENV_FILE_CHANGED,
  eventOf, isPreconditionFailed, lastPart, lbConfigOf, mapLimit, ms, primaryTaskDef, revisionOf, SCALABLE_BATCH, scalableTargetsOf, SECRET_CHANGED,
  securityGroupOf, serviceOf, taggedHostFilters, taggedHostOf, tagMap, targetHealthOf, taskDefOf, versionWithStage,
  type LbConfig, type SdkRule, type SdkScalableTarget, type SdkScalingPolicy, type TargetHealthDetail,
} from "../aws-mapping.ts";
import { roleArnFromCaller } from "../capability-rules.ts";
import { LIMITS, REGION } from "../config.ts";
import { jsonKeyValue, parseSecretRef, withJsonKey } from "../envvars.ts";
import { periodFor } from "../metric-specs.ts";
import type { InsightsResult, RawBox, RawDb, RawRevision, RawService } from "../types.ts";
import { limitedClient } from "./aws-limiter.ts";
import { cached, memo } from "./cache.ts";
import { accessDeniedOf, HttpError, isOutcomeUnknown, OutcomeUnknownError } from "./errors.ts";
import type { Cloud, HostSpec, Placement } from "./sources.ts";

const cfg = (region: string) => ({ region, retryMode: "adaptive" as const, maxAttempts: 3 });
const once = (region: string) => ({ region, maxAttempts: 1 }); // writes: never retried by the SDK (see the header)
// The clients of one region, each bounded by the SDK-call limiter under its service and this region. The write clients
// share their service's slots with the readers.
function clientsFor(region: string) {
  return {
    ecs: limitedClient(new ECSClient(cfg(region)), "ecs", region),
    ecr: limitedClient(new ECRClient(cfg(region)), "ecr", region),
    logs: limitedClient(new CloudWatchLogsClient(cfg(region)), "logs", region),
    cw: limitedClient(new CloudWatchClient(cfg(region)), "cloudwatch", region),
    ec2: limitedClient(new EC2Client(cfg(region)), "ec2", region),
    rds: limitedClient(new RDSClient(cfg(region)), "rds", region),
    cache: limitedClient(new ElastiCacheClient(cfg(region)), "elasticache", region),
    elb: limitedClient(new ElasticLoadBalancingV2Client(cfg(region)), "elasticloadbalancing", region),
    ssm: limitedClient(new SSMClient(cfg(region)), "ssm", region),
    secrets: limitedClient(new SecretsManagerClient(cfg(region)), "secretsmanager", region),
    s3: limitedClient(new S3Client(cfg(region)), "s3", region),
    aas: limitedClient(new ApplicationAutoScalingClient(cfg(region)), "application-autoscaling", region),
    sts: limitedClient(new STSClient(cfg(region)), "sts", region),
    iam: limitedClient(new IAMClient(cfg(region)), "iam", region), // a global service: the SDK resolves its endpoint
    w: {
      ecs: limitedClient(new ECSClient(once(region)), "ecs", region),
      ec2: limitedClient(new EC2Client(once(region)), "ec2", region),
      rds: limitedClient(new RDSClient(once(region)), "rds", region),
      ssm: limitedClient(new SSMClient(once(region)), "ssm", region),
      secrets: limitedClient(new SecretsManagerClient(once(region)), "secretsmanager", region),
      s3: limitedClient(new S3Client(once(region)), "s3", region),
    },
  };
}
type Clients = ReturnType<typeof clientsFor>;

const t = () => ({ abortSignal: AbortSignal.timeout(LIMITS.awsTimeoutMs) });
const tw = () => ({ abortSignal: AbortSignal.timeout(LIMITS.awsWriteTimeoutMs) });
const CONCURRENCY = 4; // describes in flight per call (the limiter bounds the region as a whole)

// A write's outcome: a timeout or reset connection after the request left (aws-limiter.ts flags it) means AWS may have
// acted — OutcomeUnknownError, so mutate() records outcome_unknown and nobody retries it blindly.
async function sent<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isOutcomeUnknown(e)) throw new OutcomeUnknownError(undefined, { cause: e, requestId: (e as { $metadata?: { requestId?: string } }).$metadata?.requestId });
    throw e;
  }
}

function toBox(i: Instance, agentConnected?: boolean): RawBox {
  const tags = tagMap(i.Tags);
  return {
    id: i.InstanceId!, name: tags.Name ?? i.InstanceId!, state: i.State?.Name ?? "unknown", type: i.InstanceType ?? "",
    launchedAt: ms(i.LaunchTime), privateIp: i.PrivateIpAddress, publicIp: i.PublicIpAddress, az: i.Placement?.AvailabilityZone,
    platform: i.PlatformDetails, vpcId: i.VpcId, securityGroups: (i.SecurityGroups ?? []).map((g) => g.GroupId!).filter(Boolean),
    tags, asg: tags["aws:autoscaling:groupName"], agentConnected,
  };
}

// Task definitions are immutable per ARN → cache forever. Environment values and secrets never leave taskDefOf.
const taskDef = (k: Clients, arn: string) =>
  memo(`td:${arn}`, async () => taskDefOf((await k.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }), t())).taskDefinition!));

// The full task definition, including environment values — used only to re-register it with edited variables.
const fullTaskDef = (k: Clients, arn: string) =>
  memo(`tdfull:${arn}`, async () => {
    const r = await k.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn, include: ["TAGS"] }), t());
    return { td: r.taskDefinition!, tags: r.tags ?? [] };
  });

// Everything RegisterTaskDefinition accepts, copied from the current revision; read-only fields are left behind.
function registerInput(td: TaskDefinition, tags: Tag[], containers: ContainerDefinition[]): RegisterTaskDefinitionCommandInput {
  const input: RegisterTaskDefinitionCommandInput = {
    family: td.family!, taskRoleArn: td.taskRoleArn, executionRoleArn: td.executionRoleArn, networkMode: td.networkMode,
    containerDefinitions: containers, volumes: td.volumes, placementConstraints: td.placementConstraints,
    requiresCompatibilities: td.requiresCompatibilities, cpu: td.cpu, memory: td.memory, pidMode: td.pidMode, ipcMode: td.ipcMode,
    proxyConfiguration: td.proxyConfiguration, inferenceAccelerators: td.inferenceAccelerators, ephemeralStorage: td.ephemeralStorage,
    runtimePlatform: td.runtimePlatform, enableFaultInjection: td.enableFaultInjection, tags: tags.length ? tags : undefined,
  };
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as RegisterTaskDefinitionCommandInput;
}

const register = async (k: Clients, input: RegisterTaskDefinitionCommandInput) =>
  (await sent(k.w.ecs.send(new RegisterTaskDefinitionCommand(input), tw()))).taskDefinition!.taskDefinitionArn!;

// A new revision identical to `arn` except one container's image (the cloud map's "Deploy image" action,
// providers/ecs-image.ts, which validates the image first). Tags travel, like registerWithEnv. → new revision ARN.
async function registerWithImage(k: Clients, arn: string, container: string, image: string): Promise<string> {
  const { td, tags } = await fullTaskDef(k, arn);
  const defs = td.containerDefinitions ?? [];
  if (!defs.some((c) => c.name === container)) throw new Error(`container "${container}" isn't in ${arn}`);
  return register(k, registerInput(td, tags, defs.map((c) => (c.name === container ? { ...c, image } : c))));
}

// ---------- create & scale ----------

const ecsTags = (tags: Record<string, string>) => Object.entries(tags).map(([key, value]) => ({ key, value }));

// Where tasks run, shared by CreateService and RunTask. A capacity provider strategy replaces the launch type.
function placement(s: Placement) {
  const cps = s.capacityProviderStrategy;
  return {
    launchType: cps.length ? undefined : (s.launchType as LaunchType | undefined),
    capacityProviderStrategy: cps.length ? cps.map((c) => ({ capacityProvider: c.provider, weight: c.weight, base: c.base })) : undefined,
    platformVersion: s.platformVersion,
    networkConfiguration: s.network
      ? { awsvpcConfiguration: { subnets: s.network.subnets, securityGroups: s.network.securityGroups, assignPublicIp: s.network.assignPublicIp ? ("ENABLED" as const) : ("DISABLED" as const) } }
      : undefined,
    placementConstraints: s.placementConstraints.length ? s.placementConstraints.map((c) => ({ type: c.type as PlacementConstraintType, expression: c.expression })) : undefined,
    placementStrategy: s.placementStrategy.length ? s.placementStrategy.map((p) => ({ type: p.type as PlacementStrategyType, field: p.field })) : undefined,
  };
}

// An instance plus its user data (base64, the form RunInstances takes). User data often holds secrets: it never
// leaves this file — HostSpec only says whether there is some.
async function describeHost(k: Clients, id: string) {
  const [d, ud] = await Promise.all([
    k.ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }), t()),
    k.ec2.send(new DescribeInstanceAttributeCommand({ InstanceId: id, Attribute: "userData" }), t()),
  ]);
  const i = d.Reservations?.flatMap((r) => r.Instances ?? [])[0];
  if (!i) throw Object.assign(new Error(`InvalidInstanceID.NotFound: ${id}`), { name: "InvalidInstanceID.NotFound" });
  const tags = tagMap(i.Tags);
  const lt = tags["aws:ec2launchtemplate:id"];
  const spec: HostSpec = {
    id, imageId: i.ImageId ?? "", instanceType: i.InstanceType ?? "", subnetId: i.SubnetId,
    securityGroups: (i.SecurityGroups ?? []).map((g) => g.GroupId!).filter(Boolean), instanceProfileArn: i.IamInstanceProfile?.Arn, keyName: i.KeyName,
    hasUserData: !!ud.UserData?.Value, launchTemplate: lt ? { id: lt, version: tags["aws:ec2launchtemplate:version"] ?? "$Default" } : undefined,
    asg: tags["aws:autoscaling:groupName"], hasPublicIp: !!i.PublicIpAddress, tags,
  };
  return { spec, instance: i, userData: ud.UserData?.Value };
}

const s3Loc = (arn: string) => {
  const m = /^arn:aws[\w-]*:s3:::([^/]+)\/(.+)$/.exec(arn);
  if (!m) throw new Error(`not an S3 object ARN: ${arn}`);
  return { Bucket: m[1], Key: m[2] };
};

async function listAll(k: Clients, cluster: string) {
  return (
    await allPages(async (nextToken) => {
      const r = await k.ecs.send(new ListServicesCommand({ cluster, maxResults: 100, nextToken }), t());
      return { items: r.serviceArns ?? [], next: r.nextToken };
    })
  ).items;
}

// The newest `want` ACTIVE revision ARNs of exactly this family. ListTaskDefinitions' familyPrefix is a prefix ("api"
// also lists "api-worker"), and DESC sorts by family name before revision, so every longer family sharing the prefix
// comes first: page past them, up to REVISION_PAGES.
const REVISION_PAGES = 10;
async function familyRevisions(k: Clients, family: string, want: number): Promise<string[]> {
  const mine: string[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < REVISION_PAGES && mine.length < want; page++) {
    const r = await k.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, sort: "DESC", status: "ACTIVE", maxResults: 100, nextToken }), t());
    mine.push(...(r.taskDefinitionArns ?? []).filter((a) => a.split("/").pop()!.replace(/:\d+$/, "") === family));
    nextToken = r.nextToken;
    if (!nextToken) break;
  }
  return mine.slice(0, want);
}

// An SSM parameter's metadata (type, tier, KMS key, Version) — never its value.
async function ssmParam(k: Clients, name: string) {
  const d = await k.ssm.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Option: "Equals", Values: [name] }] }), t());
  return d.Parameters?.[0];
}

export function awsCloud(region: string = REGION): Cloud {
  const k = clientsFor(region);

  // ECR clients of other regions, for images whose registry is elsewhere (the image says where).
  const ecrClients = new Map<string, Clients["ecr"]>();
  const ecrIn = (r: string) => {
    if (r === region) return k.ecr;
    let c = ecrClients.get(r);
    if (!c) ecrClients.set(r, (c = limitedClient(new ECRClient(cfg(r)), "ecr", r)));
    return c;
  };

  // One DescribeTargetHealth per target group per 10 s, whoever asks (service status, the load balancer panel, the map).
  const tgHealth = (arn: string): Promise<TargetHealthDetail> =>
    cached(`aws:tgh:${arn}`, 10_000, async () =>
      targetHealthOf(arn, (await k.elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }), t())).TargetHealthDescriptions ?? []),
    ).then((r) => r.value);
  const targetHealth = (arns: string[]) => mapLimit([...arns], CONCURRENCY, tgHealth);

  const marker = async <T,>(page: (Marker?: string) => Promise<{ items?: T[]; NextMarker?: string }>) =>
    (await allPages(async (m) => {
      const r = await page(m);
      return { items: r.items ?? [], next: r.NextMarker };
    })).items;

  // Static configuration of a load balancer (F58): listeners, rules and target groups, re-read every 10 minutes.
  const lbConfig = (arn: string): Promise<LbConfig> =>
    cached(`aws:lbcfg:${arn}`, 10 * 60_000, async () => {
      const [lbR, groups, listeners] = await Promise.all([
        k.elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn] }), t()),
        marker((Marker) => k.elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: arn, Marker }), t()).then((r) => ({ items: r.TargetGroups, NextMarker: r.NextMarker }))),
        marker((Marker) => k.elb.send(new DescribeListenersCommand({ LoadBalancerArn: arn, Marker }), t()).then((r) => ({ items: r.Listeners, NextMarker: r.NextMarker }))),
      ]);
      const lb = lbR.LoadBalancers?.[0];
      if (!lb) throw Object.assign(new Error(`LoadBalancerNotFound: ${arn}`), { name: "LoadBalancerNotFoundException" });
      const withRules = await mapLimit(listeners, CONCURRENCY, async (l) => ({
        port: l.Port, protocol: l.Protocol,
        rules: await marker<SdkRule>((Marker) => k.elb.send(new DescribeRulesCommand({ ListenerArn: l.ListenerArn, Marker }), t()).then((r) => ({ items: r.Rules, NextMarker: r.NextMarker }))),
      }));
      return lbConfigOf(lb, withRules, groups);
    }).then((r) => r.value);

  const targetGroupLbs = async (arns: string[]) => {
    const out: Record<string, string> = {};
    for (const batch of chunk([...new Set(arns)], 20)) {
      const r = await k.elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: batch }), t());
      for (const g of r.TargetGroups ?? []) out[g.TargetGroupArn!] = g.LoadBalancerArns?.[0] ?? "";
    }
    return out;
  };

  // The identity's role (not the session), for the policy simulation. Fixed for the process's lifetime.
  const principal = () =>
    memo(`aws:principal:${region}`, async () => {
      const r = await k.sts.send(new GetCallerIdentityCommand({}), t());
      return r.Arn ? roleArnFromCaller(r.Arn) : undefined;
    });

  return {
    kind: "aws",

    region,

    async clusters() {
      const arns = (
        await allPages(async (nextToken) => {
          const r = await k.ecs.send(new ListClustersCommand({ maxResults: 100, nextToken }), t());
          return { items: r.clusterArns ?? [], next: r.nextToken };
        })
      ).items;
      const out = [];
      for (const batch of chunk(arns, 100)) {
        const r = await k.ecs.send(new DescribeClustersCommand({ clusters: batch, include: ["TAGS"] }), t());
        for (const c of r.clusters ?? []) {
          out.push({
            name: c.clusterName!, arn: c.clusterArn!, status: c.status ?? "UNKNOWN", tags: tagMap(c.tags),
            activeServices: c.activeServicesCount ?? 0, runningTasks: c.runningTasksCount ?? 0,
            containerInstances: c.registeredContainerInstancesCount ?? 0, capacityProviders: c.capacityProviders ?? [],
          });
        }
      }
      return out;
    },

    // Every service with all its RUNNING tasks (paged, R13), its recent stopped ones, its events (F11) and its PRIMARY
    // task definition (each definition fetched once). Describes run a few at a time.
    async services(cluster) {
      const [arns, tasks] = await Promise.all([
        listAll(k, cluster),
        clusterTasks({
          list: (desiredStatus, nextToken) => k.ecs.send(new ListTasksCommand({ cluster, desiredStatus, maxResults: 100, nextToken }), t()),
          describe: async (batch) => (await k.ecs.send(new DescribeTasksCommand({ cluster, tasks: batch }), t())).tasks ?? [],
          taskDef: (arn) => taskDef(k, arn),
        }, { concurrency: CONCURRENCY }),
      ]);
      const described = (
        await mapLimit(chunk(arns, 10), CONCURRENCY, async (batch) => (await k.ecs.send(new DescribeServicesCommand({ cluster, services: batch, include: ["TAGS"] }), t())).services ?? [])
      ).flat();
      const primaries = [...new Set(described.map(primaryTaskDef).filter((a): a is string => !!a))];
      const defs = new Map(await mapLimit(primaries, CONCURRENCY, async (a) => [a, await taskDef(k, a)] as const));
      return described.map((s): RawService => {
        const p = primaryTaskDef(s);
        return serviceOf(cluster, s, tasks, (p && defs.get(p)) || null);
      });
    },

    async hosts(cluster) {
      const arns = (
        await allPages(async (nextToken) => {
          const r = await k.ecs.send(new ListContainerInstancesCommand({ cluster, maxResults: 100, nextToken }), t());
          return { items: r.containerInstanceArns ?? [], next: r.nextToken };
        })
      ).items;
      if (!arns.length) return [];
      const agent = new Map<string, boolean>();
      for (const batch of chunk(arns, 100)) {
        const r = await k.ecs.send(new DescribeContainerInstancesCommand({ cluster, containerInstances: batch }), t());
        for (const ci of r.containerInstances ?? []) if (ci.ec2InstanceId) agent.set(ci.ec2InstanceId, !!ci.agentConnected);
      }
      const out: RawBox[] = [];
      for (const batch of chunk([...agent.keys()], 100)) {
        const r = await k.ec2.send(new DescribeInstancesCommand({ InstanceIds: batch }), t());
        for (const i of r.Reservations?.flatMap((x) => x.Instances ?? []) ?? []) out.push(toBox(i, agent.get(i.InstanceId!)));
      }
      return out;
    },

    async instances(ids) {
      if (!ids.length) return [];
      // A filter, not InstanceIds: an id that no longer exists is simply absent instead of failing the whole read.
      const r = await k.ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-id", Values: ids }] }), t());
      return r.Reservations?.flatMap((x) => x.Instances ?? []).map((i) => toBox(i)) ?? [];
    },

    async taggedHosts(cluster) {
      const found = await allPages(async (NextToken) => {
        const r = await k.ec2.send(new DescribeInstancesCommand({ Filters: taggedHostFilters(cluster), MaxResults: 100, NextToken }), t());
        return { items: r.Reservations?.flatMap((x) => x.Instances ?? []) ?? [], next: r.NextToken };
      });
      return found.items.map(taggedHostOf);
    },

    async databases() {
      const found = await allPages(async (Marker) => {
        const r = await k.rds.send(new DescribeDBInstancesCommand({ Marker, MaxRecords: 100 }), t());
        return { items: r.DBInstances ?? [], next: r.Marker };
      });
      return found.items.map((d): RawDb => dbOf(d));
    },

    async caches() {
      const [groups, clusters] = await Promise.all([
        allPages(async (Marker) => {
          const r = await k.cache.send(new DescribeReplicationGroupsCommand({ Marker, MaxRecords: 100 }), t());
          return { items: r.ReplicationGroups ?? [], next: r.Marker };
        }),
        allPages(async (Marker) => {
          const r = await k.cache.send(new DescribeCacheClustersCommand({ Marker, MaxRecords: 100, ShowCacheNodeInfo: true }), t());
          return { items: r.CacheClusters ?? [], next: r.Marker };
        }),
      ]);
      return cachesOf(groups.items, clusters.items);
    },

    async securityGroups(ids) {
      const out = [];
      for (const batch of chunk([...new Set(ids)], 200)) {
        const r = await k.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: batch }), t());
        for (const g of r.SecurityGroups ?? []) out.push(securityGroupOf(g));
      }
      return out;
    },

    async subnetVpcs(ids) {
      if (!ids.length) return {};
      const r = await k.ec2.send(new DescribeSubnetsCommand({ SubnetIds: [...new Set(ids)] }), t());
      return Object.fromEntries((r.Subnets ?? []).map((x) => [x.SubnetId!, x.VpcId!]));
    },

    targetHealth,

    // Period from metric-specs.ts periodFor (F03); each batch is read to its last NextToken page (F29). A series that
    // still isn't Complete is logged, never padded.
    async metrics(specs, minutes) {
      if (!specs.length) return {};
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60_000);
      const period = periodFor(minutes);
      const out: Record<string, [number, number][]> = {};
      const status = new Map<string, string>();
      for (const batch of chunk(specs, 500)) {
        let NextToken: string | undefined;
        do {
          const r = await k.cw.send(
            new GetMetricDataCommand({
              StartTime: start,
              EndTime: end,
              ScanBy: "TimestampAscending",
              NextToken,
              MetricDataQueries: batch.map((s) => ({
                Id: s.id,
                ReturnData: true,
                MetricStat: {
                  Metric: { Namespace: s.namespace, MetricName: s.metric, Dimensions: Object.entries(s.dims).map(([Name, Value]) => ({ Name, Value })) },
                  Period: period,
                  Stat: s.stat,
                },
              })),
            }),
            t(),
          );
          appendMetrics(out, status, r.MetricDataResults ?? []);
          NextToken = r.NextToken;
        } while (NextToken);
      }
      const partial = [...status].filter(([, s]) => s && s !== "Complete").map(([id, s]) => `${id}:${s}`);
      if (partial.length) console.warn(JSON.stringify({ level: 40, msg: "metrics: series not complete", region, series: partial.slice(0, 20), more: Math.max(0, partial.length - 20) }));
      return out;
    },

    async revisions(family) {
      const mine = await familyRevisions(k, family, 30);
      const defs = await mapLimit(mine, CONCURRENCY, (a) => taskDef(k, a));
      return defs.map((d): RawRevision => revisionOf(d));
    },

    async imageTags(repositoryName) {
      const tags = new Set<string>();
      let nextToken: string | undefined;
      do {
        const r = await k.ecr.send(new DescribeImagesCommand({ repositoryName, filter: { tagStatus: "TAGGED" }, maxResults: 1000, nextToken }), t());
        for (const d of r.imageDetails ?? []) for (const tag of d.imageTags ?? []) tags.add(tag);
        nextToken = r.nextToken;
      } while (nextToken);
      return tags;
    },

    // R24/F68: one image by digest (immutable, preferred) or tag, in whichever account and region its registry names.
    // A missing image or repository is { exists: false }; AccessDenied and other errors throw (unknown, not missing).
    async imageExists(repository, ref) {
      const where = ecrTarget(repository, region);
      if (!where) return null;
      const digest = ref.digest ?? where.digest;
      const tag = ref.tag ?? where.tag ?? "latest";
      try {
        const r = await ecrIn(where.region).send(
          new DescribeImagesCommand({ repositoryName: where.repositoryName, registryId: where.registryId, imageIds: [digest ? { imageDigest: digest } : { imageTag: tag }] }),
          t(),
        );
        const d = r.imageDetails?.[0];
        return d ? { exists: true, ...(d.imageDigest ? { digest: d.imageDigest } : {}) } : { exists: false };
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (name === "ImageNotFoundException" || name === "RepositoryNotFoundException") return { exists: false };
        throw e;
      }
    },

    async events(cluster, service) {
      const r = await k.ecs.send(new DescribeServicesCommand({ cluster, services: [service] }), t());
      return (r.services?.[0]?.events ?? []).map(eventOf);
    },

    // CC-20: the targets of this cluster's services (50 resource ids per call), then each target's policies.
    async scalableTargets(cluster) {
      return (
        await cached(`aws:aas:${region}/${cluster}`, 5 * 60_000, async () => {
          const ids = (await listAll(k, cluster)).map((a) => ecsResourceId(cluster, lastPart(a)));
          const targets: SdkScalableTarget[] = [];
          for (const ResourceIds of chunk(ids, SCALABLE_BATCH)) {
            const found = await allPages(async (NextToken) => {
              const r = await k.aas.send(new DescribeScalableTargetsCommand({ ServiceNamespace: "ecs", ScalableDimension: ECS_DIMENSION, ResourceIds, NextToken }), t());
              return { items: r.ScalableTargets ?? [], next: r.NextToken };
            });
            targets.push(...found.items);
          }
          const policies: SdkScalingPolicy[] = (
            await mapLimit(targets, CONCURRENCY, async (x) =>
              (await allPages(async (NextToken) => {
                const r = await k.aas.send(new DescribeScalingPoliciesCommand({ ServiceNamespace: "ecs", ResourceId: x.ResourceId, ScalableDimension: ECS_DIMENSION, NextToken }), t());
                return { items: r.ScalingPolicies ?? [], next: r.NextToken };
              })).items,
            )
          ).flat();
          return scalableTargetsOf(cluster, targets, policies);
        })
      ).value;
    },

    async updateService(cluster, service, change) {
      const r = await sent(
        k.w.ecs.send(
          new UpdateServiceCommand({
            cluster,
            service,
            desiredCount: change.desired,
            taskDefinition: change.taskDefinition,
            forceNewDeployment: change.force,
          }),
          tw(),
        ),
      );
      return r.$metadata.requestId ?? "";
    },

    async hostPower(instanceId, action) {
      const r = await sent(k.w.ec2.send(action === "start" ? new StartInstancesCommand({ InstanceIds: [instanceId] }) : new StopInstancesCommand({ InstanceIds: [instanceId] }), tw()));
      return r.$metadata.requestId ?? "";
    },

    async dbPower(id, action) {
      const r = await sent(k.w.rds.send(action === "start" ? new StartDBInstanceCommand({ DBInstanceIdentifier: id }) : new StopDBInstanceCommand({ DBInstanceIdentifier: id }), tw()));
      return r.$metadata.requestId ?? "";
    },

    targetGroupLbs: (arns) => (arns.length ? targetGroupLbs(arns) : Promise.resolve({})),

    lbConfig,

    async logAround(group, stream, ts, n) {
      const [b, a] = await Promise.all([
        k.logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, endTime: ts, startFromHead: false, limit: n }), t()),
        k.logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startTime: ts, startFromHead: true, limit: n + 1 }), t()),
      ]);
      const map = (e: { timestamp?: number; message?: string }) => ({ ts: e.timestamp ?? 0, msg: e.message ?? "" });
      return { before: (b.events ?? []).map(map), after: (a.events ?? []).map(map) };
    },

    async insightsStart(groups, query, start, end, limit) {
      const r = await k.logs.send(
        new StartQueryCommand({ logGroupNames: groups, queryString: query, startTime: Math.floor(start / 1000), endTime: Math.ceil(end / 1000), limit }),
        t(),
      );
      return r.queryId!;
    },

    async insightsResults(id): Promise<InsightsResult> {
      const r = await k.logs.send(new GetQueryResultsCommand({ queryId: id }), t());
      return {
        status: (r.status as InsightsResult["status"]) ?? "Unknown",
        rows: (r.results ?? []).map((row) => Object.fromEntries(row.filter((f) => f.field && f.field !== "@ptr").map((f) => [f.field!, f.value ?? ""]))),
        stats: r.statistics ? { recordsMatched: r.statistics.recordsMatched ?? 0, recordsScanned: r.statistics.recordsScanned ?? 0, bytesScanned: r.statistics.bytesScanned ?? 0 } : undefined,
      };
    },

    // Newest streams first. AWS can't combine a name prefix with LastEventTime ordering, so for a shared log group
    // we page the newest streams and keep the ones under this service's prefix.
    async logStreams(group, prefix) {
      try {
        const out: { name: string; lastEventAt: number }[] = [];
        let nextToken: string | undefined;
        for (let page = 0; page < (prefix ? 4 : 1) && out.length < 5; page++) {
          const r = await k.logs.send(new DescribeLogStreamsCommand({ logGroupName: group, orderBy: "LastEventTime", descending: true, limit: prefix ? 50 : 5, nextToken }), t());
          for (const s of r.logStreams ?? []) if (!prefix || s.logStreamName!.startsWith(prefix)) out.push({ name: s.logStreamName!, lastEventAt: s.lastEventTimestamp ?? s.creationTime ?? 0 });
          nextToken = r.nextToken;
          if (!nextToken) break;
        }
        return out.slice(0, 5);
      } catch (e) {
        if ((e as Error).name === "ResourceNotFoundException") return [];
        throw e;
      }
    },

    async logEvents(group, stream, o) {
      const r = await k.logs.send(
        new GetLogEventsCommand({
          logGroupName: group,
          logStreamName: stream,
          nextToken: o.token,
          startFromHead: o.token ? undefined : o.fromHead,
          endTime: o.token ? undefined : o.end,
          limit: o.limit,
        }),
        t(),
      );
      return {
        events: (r.events ?? []).map((e) => ({ ts: e.timestamp ?? 0, msg: e.message ?? "" })),
        forward: r.nextForwardToken ?? "",
        backward: r.nextBackwardToken ?? "",
      };
    },

    async filterLogs(group, o) {
      const r = await k.logs.send(
        new FilterLogEventsCommand({
          logGroupName: group,
          startTime: o.start,
          endTime: o.end,
          filterPattern: o.pattern,
          logStreamNamePrefix: o.prefix,
          nextToken: o.token,
          limit: o.limit,
        }),
        t(),
      );
      return {
        events: (r.events ?? []).map((e) => ({ ts: e.timestamp ?? 0, msg: e.message ?? "", stream: e.logStreamName ?? "" })),
        next: r.nextToken,
      };
    },

    async containerEnv(arn) {
      const { td } = await fullTaskDef(k, arn);
      return (td.containerDefinitions ?? []).map((c) => ({
        container: c.name ?? "",
        environment: (c.environment ?? []).map((e) => ({ name: e.name ?? "", value: e.value ?? "" })),
        secrets: (c.secrets ?? []).map((x) => ({ name: x.name ?? "", valueFrom: x.valueFrom ?? "" })),
        files: (c.environmentFiles ?? []).filter((f) => f.type === "s3" && f.value).map((f) => f.value!),
      }));
    },

    registerWithImage: (arn, container, image) => registerWithImage(k, arn, container, image),
    async registerWithEnv(arn, edits) {
      const { td, tags } = await fullTaskDef(k, arn);
      const containers = (td.containerDefinitions ?? []).map((c) => {
        const e = edits.find((x) => x.container === c.name);
        return e ? { ...c, environment: e.environment } : c;
      });
      return register(k, registerInput(td, tags, containers));
    },

    async readSecret(valueFrom) {
      const ref = parseSecretRef(valueFrom);
      if (ref.kind === "ssm") return (await k.ssm.send(new GetParameterCommand({ Name: ref.name, WithDecryption: true }), t())).Parameter?.Value ?? "";
      const r = await k.secrets.send(new GetSecretValueCommand({ SecretId: ref.secretId, VersionStage: ref.versionStage, VersionId: ref.versionId }), t());
      const str = r.SecretString ?? "";
      return ref.jsonKey ? jsonKeyValue(str, ref.jsonKey) : str;
    },

    // R05: metadata reads only (DescribeParameters, DescribeSecret) — a version is never worth reading a value for.
    async secretVersion(valueFrom) {
      const ref = parseSecretRef(valueFrom);
      if (ref.kind === "ssm") {
        const p = await ssmParam(k, ref.name);
        return p?.Version !== undefined ? String(p.Version) : undefined;
      }
      if (ref.versionId) return ref.versionId;
      const d = await k.secrets.send(new DescribeSecretCommand({ SecretId: ref.secretId }), t());
      return versionWithStage(d.VersionIdsToStages, ref.versionStage ?? "AWSCURRENT");
    },

    // Neither SSM nor Secrets Manager has a compare-and-set: with ifVersion, the version is re-read right before the
    // write and the write is refused (409) when it moved. A change landing in the milliseconds between that read and the
    // write still wins — the APIs leave no way to close that window.
    async writeSecret(valueFrom, value, o = {}) {
      const ref = parseSecretRef(valueFrom);
      if (ref.kind === "ssm") {
        // Keep the parameter's type, tier and KMS key — PutParameter would otherwise fall back to defaults.
        const p = await ssmParam(k, ref.name);
        if (!p) throw new Error(`SSM parameter ${ref.name} not found`);
        if (o.ifVersion !== undefined && String(p.Version) !== o.ifVersion) throw new HttpError(409, SECRET_CHANGED);
        const r = await sent(
          k.w.ssm.send(new PutParameterCommand({ Name: ref.name, Value: value, Overwrite: true, Type: p.Type, Tier: p.Tier, KeyId: p.Type === "SecureString" ? p.KeyId : undefined }), tw()),
        );
        return r.Version !== undefined ? { version: String(r.Version) } : {};
      }
      if (ref.versionStage || ref.versionId) throw new Error("this reference pins a secret version — a new value would not reach the service; update the secret in AWS and the reference together");
      let next = value;
      if (ref.jsonKey) {
        // One key of a JSON secret: the document read here is the one merged into, and its version the one checked.
        const cur = await k.secrets.send(new GetSecretValueCommand({ SecretId: ref.secretId }), t());
        if (o.ifVersion !== undefined && cur.VersionId !== o.ifVersion) throw new HttpError(409, SECRET_CHANGED);
        next = withJsonKey(cur.SecretString ?? "{}", ref.jsonKey, value);
      } else if (o.ifVersion !== undefined) {
        const d = await k.secrets.send(new DescribeSecretCommand({ SecretId: ref.secretId }), t());
        if (versionWithStage(d.VersionIdsToStages) !== o.ifVersion) throw new HttpError(409, SECRET_CHANGED);
      }
      const r = await sent(k.w.secrets.send(new PutSecretValueCommand({ SecretId: ref.secretId, SecretString: next }), tw()));
      return r.VersionId ? { version: r.VersionId } : {};
    },

    async readEnvFile(arn) {
      const r = await k.s3.send(new GetObjectCommand(s3Loc(arn)), t());
      return { text: (await r.Body?.transformToString("utf-8")) ?? "", ...(r.ETag ? { etag: r.ETag } : {}) };
    },

    // R05: the write is conditional on the ETag the edit started from (ifMatch), else on the one read here; S3 refuses it
    // (412) when the object changed in between, and so does the read when ifMatch is already stale.
    async writeEnvFile(arn, text, o = {}) {
      const loc = s3Loc(arn);
      try {
        // Rewrite with the same encryption settings the object had (bucket policies often require them).
        const cur = await k.s3.send(new GetObjectCommand({ ...loc, IfMatch: o.ifMatch }), t());
        await cur.Body?.transformToString();
        const r = await sent(
          k.w.s3.send(
            new PutObjectCommand({
              ...loc, Body: text, ContentType: cur.ContentType ?? "text/plain", ServerSideEncryption: cur.ServerSideEncryption, SSEKMSKeyId: cur.SSEKMSKeyId,
              IfMatch: o.ifMatch ?? cur.ETag,
            }),
            tw(),
          ),
        );
        return r.ETag ? { etag: r.ETag } : {};
      } catch (e) {
        if (isPreconditionFailed(e)) throw new HttpError(409, ENV_FILE_CHANGED);
        throw e;
      }
    },

    async serviceSpec(cluster, service) {
      const r = await k.ecs.send(new DescribeServicesCommand({ cluster, services: [service] }), t());
      const s = r.services?.find((x) => x.status !== "INACTIVE");
      if (!s) throw Object.assign(new Error(`ServiceNotFoundException: ${service}`), { name: "ServiceNotFoundException" });
      const vpc = s.networkConfiguration?.awsvpcConfiguration;
      return {
        launchType: s.launchType,
        capacityProviderStrategy: (s.capacityProviderStrategy ?? []).map((c) => ({ provider: c.capacityProvider!, weight: c.weight, base: c.base })),
        network: vpc ? { subnets: vpc.subnets ?? [], securityGroups: vpc.securityGroups ?? [], assignPublicIp: vpc.assignPublicIp === "ENABLED" } : undefined,
        platformVersion: s.platformVersion,
        enableExecuteCommand: !!s.enableExecuteCommand,
        placementConstraints: (s.placementConstraints ?? []).map((c) => ({ type: c.type ?? "", expression: c.expression })),
        placementStrategy: (s.placementStrategy ?? []).map((p) => ({ type: p.type ?? "", field: p.field })),
        loadBalancers: s.loadBalancers?.length ?? 0,
        serviceRegistries: s.serviceRegistries?.length ?? 0,
        serviceConnect: !!s.deployments?.some((d) => d.serviceConnectConfiguration?.enabled),
      };
    },

    async familyInfo(family) {
      const [latest] = await familyRevisions(k, family, 1);
      if (!latest) return null;
      const d = await k.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: latest, include: ["TAGS"] }), t());
      return { consoleCreated: (d.tags ?? []).some((x) => x.key === "console:created" && x.value === "true") };
    },

    async registerCopy(arn, o) {
      const { td, tags } = await fullTaskDef(k, arn);
      const cpu = o.cpu ? Number(o.cpu) : undefined;
      const mem = o.memory ? Number(o.memory) : undefined;
      const containers = (td.containerDefinitions ?? []).map((c) => {
        const next: ContainerDefinition = { ...c };
        if (o.image && c.name === o.image.container) next.image = o.image.image;
        if (o.streamPrefix && next.logConfiguration?.logDriver === "awslogs") {
          next.logConfiguration = { ...next.logConfiguration, options: { ...next.logConfiguration.options, "awslogs-stream-prefix": o.streamPrefix } };
        }
        // A smaller task size must still hold every container's own limits.
        if (mem !== undefined) {
          if (next.memory && next.memory > mem) next.memory = mem;
          if (next.memoryReservation && next.memoryReservation > mem) next.memoryReservation = mem;
        }
        if (cpu !== undefined && next.cpu && next.cpu > cpu) next.cpu = cpu;
        return next;
      });
      // The source's own tags travel (cost allocation, owner), minus AWS-reserved ones and the console's bookkeeping.
      const keep = tags.filter((x) => x.key && !x.key.startsWith("aws:") && !x.key.startsWith("console:"));
      return register(k, registerInput({ ...td, family: o.family, cpu: o.cpu ?? td.cpu, memory: o.memory ?? td.memory }, [...keep, ...ecsTags(o.tags)], containers));
    },

    async createService(s) {
      const r = await sent(
        k.w.ecs.send(
          new CreateServiceCommand({
            cluster: s.cluster, serviceName: s.name, taskDefinition: s.taskDefinition, desiredCount: s.desired, ...placement(s),
            enableExecuteCommand: s.enableExecuteCommand,
            deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } },
            propagateTags: "SERVICE", enableECSManagedTags: true, tags: ecsTags(s.tags),
          }),
          tw(),
        ),
      );
      return r.$metadata.requestId ?? "";
    },

    async deleteService(cluster, service) {
      await sent(k.w.ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount: 0 }), tw()));
      const r = await sent(k.w.ecs.send(new DeleteServiceCommand({ cluster, service, force: true }), tw()));
      return r.$metadata.requestId ?? "";
    },

    async runTask(s) {
      const r = await sent(
        k.w.ecs.send(
          new RunTaskCommand({
            cluster: s.cluster, taskDefinition: s.taskDefinition, count: 1, ...placement(s),
            overrides: s.override ? { containerOverrides: [{ name: s.override.container, command: s.override.command }] } : undefined,
            startedBy: "deployment-console", enableECSManagedTags: true, tags: ecsTags(s.tags),
            ...(s.clientToken ? { clientToken: clientToken(s.clientToken) } : {}),
          }),
          tw(),
        ),
      );
      const task = r.tasks?.[0];
      if (!task?.taskArn) {
        const f = r.failures?.[0];
        throw new Error(`RunTask started nothing: ${f?.reason ?? "no reason given"}${f?.detail ? ` (${f.detail})` : ""}`);
      }
      return { taskArn: task.taskArn, requestId: r.$metadata.requestId ?? "" };
    },

    async hostSpec(id) {
      return (await describeHost(k, id)).spec;
    },

    async launchHosts(from, o) {
      const { spec, instance: i, userData } = await describeHost(k, from);
      const Tags = Object.entries(o.cluster ? { ...o.tags, "console:cluster": o.cluster } : o.tags).map(([Key, Value]) => ({ Key, Value }));
      const token = o.clientToken ? clientToken(o.clientToken) : undefined;
      const base: RunInstancesCommandInput = {
        MinCount: o.count, MaxCount: o.count, InstanceType: o.instanceType as _InstanceType | undefined,
        TagSpecifications: [{ ResourceType: "instance", Tags }, { ResourceType: "volume", Tags }],
        ...(token ? { ClientToken: token } : {}),
      };
      let r;
      if (spec.launchTemplate) {
        const lt: RunInstancesCommandInput = { ...base, LaunchTemplate: { LaunchTemplateId: spec.launchTemplate.id, Version: spec.launchTemplate.version } };
        try {
          r = await sent(k.w.ec2.send(new RunInstancesCommand({ ...lt, SubnetId: spec.subnetId }), tw()));
        } catch (e) {
          // A template that defines network interfaces can't take a subnet as well: let it place the instance itself.
          // That is a different request, so it gets its own (still deterministic) token.
          if ((e as Error).name !== "InvalidParameterCombination") throw e;
          r = await sent(k.w.ec2.send(new RunInstancesCommand({ ...lt, ...(token ? { ClientToken: clientToken(`${o.clientToken}/no-subnet`) } : {}) }), tw()));
        }
      } else {
        const md = i.MetadataOptions;
        r = await sent(
          k.w.ec2.send(
            new RunInstancesCommand({
              ...base, InstanceType: (o.instanceType ?? spec.instanceType) as _InstanceType, ImageId: spec.imageId, SubnetId: spec.subnetId,
              SecurityGroupIds: spec.securityGroups.length ? spec.securityGroups : undefined, IamInstanceProfile: spec.instanceProfileArn ? { Arn: spec.instanceProfileArn } : undefined,
              KeyName: spec.keyName, UserData: userData,
              // IMDS settings matter to ECS (tasks reach credentials through them): keep the source's.
              MetadataOptions: md ? { HttpTokens: md.HttpTokens, HttpPutResponseHopLimit: md.HttpPutResponseHopLimit, HttpEndpoint: md.HttpEndpoint } : undefined,
            }),
            tw(),
          ),
        );
      }
      return { instanceIds: (r.Instances ?? []).map((x) => x.InstanceId!).filter(Boolean), requestId: r.$metadata.requestId ?? "" };
    },

    async terminateHost(id) {
      const r = await sent(k.w.ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }), tw()));
      return r.$metadata.requestId ?? "";
    },

    // CONSOLE_REGIONS=all-enabled: the regions this account can use (opt-in-not-required plus opted-in), sorted.
    async enabledRegions() {
      const r = await k.ec2.send(new DescribeRegionsCommand({ AllRegions: false }), t());
      return (r.Regions ?? []).map((x) => x.RegionName ?? "").filter(Boolean).sort();
    },

    principal,

    // F06: what the console's own role may do, per action, for any resource. An identity that may not simulate its
    // own policy gets {} (capability.ts then relies on what real calls teach it).
    async simulate(actions) {
      const names = [...new Set(actions)];
      if (!names.length) return {};
      try {
        const source = await principal();
        if (!source) return {};
        const out: Record<string, "allowed" | "implicitDeny" | "explicitDeny"> = {};
        for (const ActionNames of chunk(names, 100)) {
          let Marker: string | undefined;
          do {
            const r = await k.iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: source, ActionNames, ResourceArns: ["*"], Marker, MaxItems: 1000 }), t());
            Object.assign(out, decisionsOf(r.EvaluationResults ?? []));
            Marker = r.IsTruncated ? r.Marker : undefined;
          } while (Marker);
        }
        return out;
      } catch (e) {
        if (accessDeniedOf(e)) return {};
        throw e;
      }
    },
  };
}
