// Two narrow interfaces, each with a real and a mock implementation, picked by CONSOLE_SOURCE.
import "server-only";
import { REGION } from "../config.ts";
import { MOCK_REGIONS } from "./providers/mock-names.ts";
import type {
  BoxAction, CiJob, CiRun, CommitInfo, InsightsResult, ProbeResult, RawBox, RawCache, RawCluster, RawDb, RawEvent,
  RawRevision, RawSecurityGroup, RawService, RawTaggedHost, ReleaseCommit, TestReport,
} from "../types.ts";
// Type-only (erased at build time, so this adds no module to the import graph — see the note above getCloud).
import type { ImageCheck, LbConfig, ScalableTarget, TargetHealthDetail } from "../aws-mapping.ts";
import type { SimDecision } from "../capability-rules.ts";
export type { ImageCheck, LbConfig, ScalableTarget, TargetHealthDetail } from "../aws-mapping.ts";

export interface MetricSpec {
  id: string; // lowercase letter first, [a-z0-9_]
  namespace: string;
  metric: string;
  dims: Record<string, string>;
  stat: "Average" | "Maximum" | "Minimum" | "Sum" | "p50" | "p90" | "p95" | "p99";
  // No CloudWatch Unit is ever requested: callers attach a *display* unit as `unit` ("%", "ms", "/min" — console.ts,
  // metric-specs.ts), and sending that as the CloudWatch Unit would fail the query. Add a differently named field if a
  // CloudWatch unit is ever needed.
}

export interface StreamInfo {
  name: string;
  lastEventAt: number;
}

export interface EventsPage {
  events: { ts: number; msg: string }[];
  forward: string;
  backward: string;
}

// Everything is scoped by ECS cluster / resource id, never by a hardcoded env name: discovery maps clusters to envs.
// One Cloud per region (getCloud(region)): the console reads every region it is configured for (src/lib/regions.ts),
// and an env or resource is always read and changed through its own region's Cloud (cloudFor(env)).
export interface Cloud {
  kind: "aws" | "mock";
  region: string;
  // discovery
  clusters(): Promise<RawCluster[]>;
  services(cluster: string): Promise<RawService[]>;
  hosts(cluster: string): Promise<RawBox[]>; // EC2 container instances
  instances(ids: string[]): Promise<RawBox[]>; // EC2 instances by id (a compose env's box); an unknown id is left out
  databases(): Promise<RawDb[]>; // every RDS instance in the region; discovery attributes them to envs
  caches(): Promise<RawCache[]>; // every ElastiCache replication group / cluster
  securityGroups(ids: string[]): Promise<RawSecurityGroup[]>;
  subnetVpcs(ids: string[]): Promise<Record<string, string>>; // subnet → VPC
  // status + metrics
  // Health per target group: counts by state (initial and draining apart) and every target; read once per ARN per 10 s.
  targetHealth(arns: string[]): Promise<TargetHealthDetail[]>;
  // Period by window (metric-specs.ts periodFor: 60 / 300 / 3600 s); Sum series are per-period sums.
  metrics(specs: MetricSpec[], minutes: number): Promise<Record<string, [number, number][]>>;
  targetGroupLbs(arns: string[]): Promise<Record<string, string>>; // target group ARN → load balancer ARN
  // A load balancer's listeners, rules and target groups, without health (F58; cached 10 min).
  lbConfig(arn: string): Promise<LbConfig>;
  revisions(family: string): Promise<RawRevision[]>; // newest first, each with all its containers' images
  imageTags(repository: string): Promise<Set<string>>;
  // Whether an image is in ECR, by tag or (preferred, immutable) digest, and the digest found. `repository` is a name in
  // this account and region, or registry-qualified (<account>.dkr.ecr.<region>.amazonaws.com/<name>). null: not an
  // ECR image (nothing here can check it). Throws when ECR refuses the read (AccessDenied): "unknown", never "missing".
  imageExists(repository: string, ref: { tag?: string; digest?: string }): Promise<ImageCheck | null>;
  // Newest first. services() carries the same events (RawService.events); this is the per-service fallback.
  events(cluster: string, service: string): Promise<RawEvent[]>;
  // Application Auto Scaling targets of the cluster's services (min, max, policies); cached 5 min (CC-20).
  scalableTargets(cluster: string): Promise<ScalableTarget[]>;
  // actions. Every write (here and below) is sent once with LIMITS.awsWriteTimeoutMs; one cut off after it was sent
  // (timeout, reset connection) throws OutcomeUnknownError (errors.ts): AWS may have acted, so it is never retried blindly.
  updateService(cluster: string, service: string, change: { desired?: number; taskDefinition?: string; force?: boolean }): Promise<string>;
  hostPower(instanceId: string, action: BoxAction): Promise<string>;
  dbPower(id: string, action: BoxAction): Promise<string>;
  // logs
  logStreams(group: string, prefix?: string): Promise<StreamInfo[]>;
  logAround(group: string, stream: string, ts: number, n: number): Promise<{ before: { ts: number; msg: string }[]; after: { ts: number; msg: string }[] }>;
  insightsStart(groups: string[], query: string, start: number, end: number, limit: number): Promise<string>;
  insightsResults(id: string): Promise<InsightsResult>;
  // `end` (no token, fromHead false): the newest events strictly before this time.
  logEvents(group: string, stream: string, o: { token?: string; fromHead?: boolean; end?: number; limit: number }): Promise<EventsPage>;
  filterLogs(group: string, o: { pattern?: string; start: number; end: number; token?: string; limit: number; prefix?: string }): Promise<{ events: { ts: number; msg: string; stream: string }[]; next?: string }>;
  // environment variables — values stay on the server except through an audited reveal
  containerEnv(taskDefinitionArn: string): Promise<ContainerEnv[]>;
  registerWithEnv(taskDefinitionArn: string, edits: { container: string; environment: { name: string; value: string }[] }[]): Promise<string>; // → new revision ARN
  registerWithImage(taskDefinitionArn: string, container: string, image: string): Promise<string>; // same revision, one container's image changed → new ARN
  readSecret(valueFrom: string): Promise<string>;
  // The version a write would replace (R05): an SSM parameter's Version, a Secrets Manager secret's AWSCURRENT VersionId
  // (the whole secret document, whatever JSON key the reference names). undefined when there is none to compare.
  secretVersion(valueFrom: string): Promise<string | undefined>;
  // ifVersion: refuse with 409 "secret changed since it was read" when the version moved (re-read just before the write;
  // neither service has a compare-and-set). Returns the version written.
  writeSecret(valueFrom: string, value: string, o?: { ifVersion?: string }): Promise<{ version?: string }>;
  readEnvFile(s3Arn: string): Promise<{ text: string; etag?: string }>;
  // ifMatch: the ETag the edit was based on; S3 refuses the write when the object changed since (→ 409 "env file
  // changed since it was read"). Returns the new ETag.
  writeEnvFile(s3Arn: string, text: string, o?: { ifMatch?: string }): Promise<{ etag?: string }>;
  // create & scale (src/lib/server/provision.ts): what the console creates is tagged console:created=true, and only
  // that is ever deleted or terminated. Callers validate everything (src/lib/provision.ts) before calling these.
  serviceSpec(cluster: string, service: string): Promise<ServiceSpec>;
  familyInfo(family: string): Promise<{ consoleCreated: boolean } | null>; // null = no ACTIVE revision in that family
  registerCopy(taskDefinitionArn: string, o: CopySpec): Promise<string>; // → new task definition ARN
  createService(spec: CreateServiceSpec): Promise<string>;
  deleteService(cluster: string, service: string): Promise<string>; // desired 0, then DeleteService (force)
  runTask(spec: RunTaskSpec): Promise<{ taskArn: string; requestId: string }>;
  hostSpec(instanceId: string): Promise<HostSpec>;
  // cluster: also tagged console:cluster=<cluster>, so taggedHosts() finds the instances before they join ECS (R23).
  // clientToken: RunInstances' idempotency token (a retry with the same token launches nothing new).
  launchHosts(
    fromInstanceId: string,
    o: { count: number; instanceType?: string; tags: Record<string, string>; cluster?: string; clientToken?: string },
  ): Promise<{ instanceIds: string[]; requestId: string }>;
  // EC2 instances tagged console:created=true and console:cluster=<cluster>, pending or running — registered with ECS
  // or not yet (R23: the host cap counts them while they boot).
  taggedHosts(cluster: string): Promise<RawTaggedHost[]>;
  terminateHost(instanceId: string): Promise<string>;
  // A new service (provision.ts create): a task definition of its own, and its own security group in the
  // environment's VPC, deleted again with the service — only groups tagged console:created=true (the policy agrees).
  registerTaskDefinition(spec: NewTaskDefSpec): Promise<string>; // → task definition ARN
  createSecurityGroup(o: { vpcId: string; name: string; description: string; tags: Record<string, string> }): Promise<string>; // → group id
  deleteSecurityGroup(id: string): Promise<string>;
  createdGroups(vpcIds: string[]): Promise<RawSecurityGroup[]>; // tagged console:created=true, with their tags
  // ECR in this region, for picking a new service's image: repositories, and a repository's newest tags.
  repositories(): Promise<{ name: string; uri: string }[]>;
  recentImages(repository: string): Promise<{ tag: string; pushedAt?: number }[]>; // newest push first, at most 50
  // Connections (providers/ecs-connect.ts): one rule in a security group admitting another group on a TCP port, and
  // ECS Service Connect. Callers check everything (src/lib/connect.ts) first.
  authorizeIngress(groupId: string, rule: { port: number; fromGroup: string; description: string }): Promise<string>;
  revokeIngress(groupId: string, rule: { port: number; fromGroup: string }): Promise<string>;
  serviceConnectOf(cluster: string, service: string): Promise<ServiceConnectConfig | null>; // null: Service Connect is off
  clusterNamespace(cluster: string): Promise<string | undefined>; // the cluster's default Service Connect namespace
  findNamespace(name: string): Promise<string | undefined>; // the ARN of an HTTP Cloud Map namespace of that name
  createNamespace(name: string, tags: Record<string, string>): Promise<string>; // → its name (ECS takes a name or an ARN), once made
  // Turns Service Connect on (or keeps it) in `namespace`, adding `expose` to what the service already serves, with
  // `taskDefinition` in the same UpdateService when given: one deployment.
  enableServiceConnect(cluster: string, service: string, o: { namespace: string; expose?: ServiceConnectExpose; taskDefinition?: string }): Promise<string>;
  registerWithPortName(taskDefinitionArn: string, container: string, port: number, name: string): Promise<string>; // → new revision ARN
  // The simulated account answers health probes itself (real ones are plain HTTP, see probes.ts).
  probe?(cluster: string, service: string, url: string): ProbeResult;
  // CONSOLE_REGIONS=all-enabled resolves through this (ec2:DescribeRegions on AWS; the simulated account's MOCK_REGIONS).
  enabledRegions?(): Promise<string[]>;
  // An IAM policy simulation of the console's own identity for these actions ({} when the identity may not simulate),
  // each against its target resource ARNs or "*" — and that identity's ARN, a role's, not the session's
  // (src/lib/server/capability.ts).
  simulate?(actions: string[], targets?: Record<string, string[]>): Promise<Record<string, SimDecision>>;
  principal?(): Promise<string | undefined>;
}

// ---------- create & scale ----------

export interface NetworkSpec {
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: boolean;
}

// What CreateService / RunTask need from an existing service that RawService doesn't carry. Load balancers, service
// registries and Service Connect are only counted: the console never copies them.
export interface ServiceSpec {
  launchType?: string; // EC2 | FARGATE | EXTERNAL; unset when a capacity provider strategy is used
  capacityProviderStrategy: { provider: string; weight?: number; base?: number }[];
  network?: NetworkSpec; // awsvpc only
  platformVersion?: string;
  enableExecuteCommand: boolean;
  placementConstraints: { type: string; expression?: string }[];
  placementStrategy: { type: string; field?: string }[];
  loadBalancers: number;
  serviceRegistries: number;
  serviceConnect: boolean;
}

export interface CopySpec {
  family: string; // new family (= the new service's name)
  image?: { container: string; image: string };
  cpu?: string; // task size override (Fargate); container limits above it are lowered to fit
  memory?: string;
  streamPrefix?: string; // awslogs-stream-prefix for every awslogs container, so the copy's logs don't mix with the source's
  tags: Record<string, string>;
}

export interface ServiceConnectConfig {
  namespace?: string;
  services: { portName: string; discoveryName?: string; dnsName?: string; port?: number }[];
}
export interface ServiceConnectExpose {
  portName: string;
  name: string; // discovery and DNS name
  port: number;
}

// One Fargate container from an image, logging to CloudWatch with the execution role a service of the environment uses.
export interface NewTaskDefSpec {
  family: string; // = the service's (and its container's) name
  image: string;
  port?: number;
  cpu: string;
  memory: string;
  executionRole: string;
  logs: { group: string; prefix: string };
  tags: Record<string, string>;
}

export type Placement = Pick<ServiceSpec, "launchType" | "capacityProviderStrategy" | "network" | "platformVersion" | "placementConstraints" | "placementStrategy">;

export interface CreateServiceSpec extends Placement {
  cluster: string;
  name: string;
  taskDefinition: string;
  desired: number;
  enableExecuteCommand: boolean;
  tags: Record<string, string>; // tasks inherit them (propagateTags SERVICE)
}

export interface RunTaskSpec extends Placement {
  cluster: string;
  taskDefinition: string;
  service: string; // the service it is run for (simulated account: where the event shows)
  override?: { container: string; command: string[] };
  tags: Record<string, string>;
  clientToken?: string; // idempotency: the same token never starts a second task (at most 64 characters; longer is hashed)
}

// An EC2 container instance, as far as launching another one like it needs. User data never leaves aws.ts.
export interface HostSpec {
  id: string;
  imageId: string;
  instanceType: string;
  subnetId?: string;
  securityGroups: string[];
  instanceProfileArn?: string;
  keyName?: string;
  hasUserData: boolean;
  launchTemplate?: { id: string; version: string }; // from the aws:ec2launchtemplate:* tags
  asg?: string;
  hasPublicIp: boolean;
  tags: Record<string, string>;
}

export interface ContainerEnv {
  container: string;
  environment: { name: string; value: string }[];
  secrets: { name: string; valueFrom: string }[];
  files: string[]; // environmentFiles of type s3, as object ARNs
}

export interface Compare {
  aheadBy: number;
  behindBy: number;
  files: string[];
  commits: ReleaseCommit[];
  complete?: boolean; // false when GitHub truncated the file or commit list (R25: "no migration changed" is then unknown)
}

export interface Ci {
  kind: "github" | "mock";
  runs(repo: string, branch: string | undefined, limit: number): Promise<CiRun[]>;
  run(repo: string, id: number): Promise<CiRun>;
  jobs(repo: string, runId: number): Promise<CiJob[]>;
  jobLog(repo: string, jobId: number): Promise<string>;
  tests(repo: string, runId: number): Promise<TestReport | null>;
  rerun(repo: string, runId: number, failedOnly: boolean): Promise<void>;
  commit(repo: string, sha: string): Promise<CommitInfo | null>;
  compare(repo: string, base: string, head: string): Promise<Compare | null>;
  // One directory's entries at a ref (R25: when a compare is truncated, the migrations directories of base and head are
  // listed and compared instead). null: the path or ref doesn't exist, or the listing was cut short.
  listDir?(repo: string, path: string, ref: string): Promise<{ name: string; sha: string }[] | null>;
  repoExists(repo: string): Promise<boolean>;
}

// One instance per region and server process, on globalThis: Next bundles instrumentation (the sampler) and the routes
// separately, and with the simulated account two copies would drift apart (an action in one, stale state in the other).
// The home region's Cloud keeps its single-region slot (__consoleCloud); other regions are in __consoleClouds.
const g = globalThis as { __consoleCloud?: Promise<Cloud>; __consoleClouds?: Map<string, Promise<Cloud>>; __consoleCi?: Promise<Ci> };

// The connection Settings → AWS connection chose, once loaded (connection-state.ts; read inline here, so this module's
// imports stay as they are). It already gives every environment variable that is set its say.
type Live = { gen: number; effective?: { source: "aws" | "mock"; home: string }; unloaded?: boolean };
const conn = () => (globalThis as { __consoleConnection?: Live }).__consoleConnection;
const live = () => conn()?.effective;

// A typo must not silently run the demo against nothing: only aws, mock or unset are accepted. Unset: Settings decides,
// else the simulated account.
export const sourceKind = (): "aws" | "mock" => {
  const v = process.env.CONSOLE_SOURCE?.trim().toLowerCase();
  if (v === "aws") return "aws";
  if (v === "mock") return "mock";
  if (v) throw new Error(`CONSOLE_SOURCE must be "aws" or "mock" (got "${process.env.CONSOLE_SOURCE}")`);
  // The database holding Settings' choice couldn't be read at boot: answering the simulated account would show (and
  // record) the demo on a console meant to read AWS.
  if (conn()?.unloaded) throw Object.assign(new Error("the console's database is unavailable, so its AWS connection isn't known yet"), { status: 503 });
  return live()?.source ?? "mock";
};

// The console's home region: AWS_REGION (or AWS_DEFAULT_REGION), else Settings' choice, else us-east-1. The simulated
// account's home is us-east-1 whatever they say.
export const homeRegion = (): string => (sourceKind() === "mock" ? MOCK_REGIONS[0] : (live()?.home ?? REGION));

// src/lib/regions.ts REGION_CODE, repeated: importing it (or errors.ts) here broke the dev server's hot reload of
// discovery.ts's dependents ("inRegion is not a function") — keep this module's imports as they are.
const REGION_CODE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

// The Cloud of one region; no region (or "global", as global resources' keys say) = the home region. Anything else must
// look like a region code: regions also come from ARNs and client-held ids, and each one builds (and keeps) its own
// set of SDK clients.
export function getCloud(region?: string): Promise<Cloud> {
  const home = homeRegion();
  const r = !region || region === "global" ? home : region;
  if (r !== home && !REGION_CODE.test(r)) return Promise.reject(Object.assign(new Error(`"${r.slice(0, 40)}" is not an AWS region`), { status: 400 }));
  // Stamped with the generation it was asked for, not the one its import resolves in: decided for this connection.
  const born = conn()?.gen ?? 0;
  const load = () => (sourceKind() === "aws" ? import("./aws.ts").then((m) => m.awsCloud(r, born)) : import("./mock.ts").then((m) => m.mockCloud(r, born)));
  if (r === home) return (g.__consoleCloud ??= load());
  const clouds = (g.__consoleClouds ??= new Map());
  let c = clouds.get(r);
  if (!c) {
    clouds.set(r, (c = load()));
    c.catch(() => clouds.get(r) === c && clouds.delete(r)); // a failed import is retried, never cached
  }
  return c;
}

// The Cloud an environment lives in: its own region's.
export const cloudFor = (env: { region: string }): Promise<Cloud> => getCloud(env.region);

export function getCi(): Promise<Ci> {
  const born = conn()?.gen ?? 0;
  g.__consoleCi ??= sourceKind() === "aws" ? import("./github.ts").then((m) => m.githubCi(born)) : import("./mock.ts").then((m) => m.mockCi(born));
  return g.__consoleCi;
}
