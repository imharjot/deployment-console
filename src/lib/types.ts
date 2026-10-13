// Shared types. Raw* shapes are what a Cloud source returns (AWS or mock); *View shapes are what the UI renders.
import type { Freshness } from "./freshness.ts";
export type { Completeness, EvidenceState, Freshness } from "./freshness.ts";

// Environments are discovered (one per ECS cluster, or as mapped in console.config.json), so any slug is valid here.
export type EnvName = string;

export interface EnvInfo {
  id: EnvName; // url-safe slug
  label: string;
  protected: boolean; // production-like: typed confirmations, reasons, operator role
  region: string;
  cluster: string; // ECS cluster name ("" for a compose env: it has no cluster, so it has no ECS services)
  clusterArn?: string;
  kind: "fargate" | "ec2" | "mixed" | "compose" | "unknown"; // compose: apps run by docker compose on one EC2 box
  host?: string; // compose envs: the box's EC2 instance id
  branch?: string; // git branch that deploys here (tag console:branch or config)
  order: number; // promotion order: lower deploys first (staging before production)
  source: "discovered" | "config";
}
export type State = "UP" | "DEGRADED" | "DOWN" | "DEPLOYING" | "STOPPED" | "BOX_STOPPED" | "UNKNOWN";
export type ResourceKind = "service" | "box" | "database" | "cache" | "loadbalancer" | "external";
export type ActionName = "restart" | "stop" | "start" | "switch";
export type BoxAction = "start" | "stop";

// ---------- raw data from a Cloud source ----------

export interface RawDeployment {
  id: string;
  status: "PRIMARY" | "ACTIVE" | "INACTIVE";
  rolloutState?: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  rolloutReason?: string;
  taskDefinition: string;
  desired: number;
  running: number;
  pending: number;
  failedTasks: number;
  createdAt: number;
  updatedAt: number;
}

export interface RawTask {
  id: string;
  taskDefinition: string;
  lastStatus: string;
  desiredStatus: string;
  health: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  hasHealthcheck: boolean;
  startedAt?: number;
  stoppedAt?: number;
  stoppedReason?: string;
  exitCode?: number;
  cpu?: string;
  memory?: string;
  privateIp?: string; // awsvpc ENI address (for "who talks to this IP")
  imageDigests?: Record<string, string>; // container name → image digest the task actually runs (F68)
}

export interface RawCluster {
  name: string;
  arn: string;
  status: string;
  tags: Record<string, string>;
  activeServices: number;
  runningTasks: number;
  containerInstances: number;
  capacityProviders: string[];
}

export interface RawContainer {
  name: string;
  image: string;
  essential: boolean;
  ports: number[];
  logGroup?: string; // awslogs driver only
  logRegion?: string; // awslogs-region, when the group lives in another region than the service
  logStreamPrefix?: string; // streams are "<prefix>/<container>/<task-id>"
  envHosts: { host: string; port?: number; via: string }[]; // hostnames named in environment values (never the values)
}

export interface RawTaskDef {
  arn: string;
  family: string;
  revision: number;
  image: string;
  cpu?: string;
  memory?: string;
  memoryReservation?: number;
  arch?: "arm64"; // runtimePlatform.cpuArchitecture ARM64 (Graviton); unset = x86_64 — Fargate prices differ
  networkMode?: string;
  launchTypes: string[];
  healthcheck?: string;
  ports: number[];
  logGroup?: string;
  registeredAt?: number;
  containers: RawContainer[];
  main: string; // name of the container that is "the service" (ports, logs, image)
  taskRoleArn?: string;
  executionRoleArn?: string;
  volumes?: { name: string; efs?: { fileSystemId: string; accessPointId?: string } }[];
}

export interface RawService {
  name: string;
  cluster: string;
  status: string;
  desired: number;
  running: number;
  pending: number;
  launchType: "EC2" | "FARGATE" | "UNKNOWN";
  deployments: RawDeployment[];
  tasks: RawTask[];
  taskDef: RawTaskDef | null;
  targetGroupArns: string[];
  circuitBreaker: boolean;
  createdAt?: number;
  tags: Record<string, string>;
  securityGroups: string[]; // awsvpc services only
  subnets: string[];
  events?: RawEvent[]; // newest first, as DescribeServices returns them (never put into the overview payload)
  serviceRegistries?: { registryArn: string; containerName?: string; containerPort?: number }[];
  deploymentController?: string; // ECS | CODE_DEPLOY | EXTERNAL
  capacityProviderStrategy?: { provider: string; weight?: number; base?: number }[];
  assignPublicIp?: boolean;
  serviceConnect?: { discoveryName?: string; clientAliases: { dnsName: string; port?: number }[] }[];
  scalable?: { min: number; max: number; policies: string[] }; // Application Auto Scaling target, when one exists (CC-20)
  // How complete the task evidence is (R13): tasksComplete is false only when the cluster's RUNNING listing hit its page
  // cap and this service has fewer tasks than DescribeServices counts; stoppedComplete is false when more stopped tasks
  // existed than the one page read. Absent = complete.
  tasksComplete?: boolean;
  stoppedComplete?: boolean;
}

export interface RawBox {
  id: string;
  name: string;
  state: string; // pending | running | stopping | stopped | shutting-down | terminated
  type: string;
  launchedAt?: number;
  privateIp?: string;
  publicIp?: string;
  az?: string;
  platform?: string;
  vpcId?: string;
  securityGroups: string[];
  tags: Record<string, string>;
  asg?: string; // Auto Scaling group — stopping such an instance just gets it replaced
  agentConnected?: boolean;
}

// An EC2 instance the console launched for a cluster (tags console:created + console:cluster), counted before it
// registers with ECS so the host cap holds while instances boot (R23).
export interface RawTaggedHost {
  id: string;
  state: string; // pending | running
  launchedAt?: number;
}

export interface RawDb {
  id: string;
  status: string;
  engine: string;
  engineVersion: string;
  instanceClass: string;
  storageGb: number;
  multiAz: boolean;
  endpoint?: string;
  port?: number;
  vpcId?: string;
  securityGroups: string[];
  tags: Record<string, string>;
  aurora?: string; // DB cluster id — Aurora instances can't be stopped one by one
  // Posture (F16): what a reviewer checks before trusting a database.
  kmsKeyId?: string;
  publiclyAccessible?: boolean;
  subnetIds?: string[];
  caCertificate?: string; // CA identifier, e.g. rds-ca-rsa2048-g1
  caValidTill?: number; // ms
  createdAt?: number;
  storageEncrypted?: boolean;
  backupRetentionDays?: number; // 0 = automated backups off
  deletionProtection?: boolean;
  backupWindow?: string;
  parameterGroup?: string;
  maintenanceWindow?: string; // PreferredMaintenanceWindow
  optionGroup?: string; // OptionGroupMemberships[0]
  subnetGroup?: string; // DBSubnetGroup name
}

export interface RawCache {
  id: string;
  status: string;
  engine: string;
  engineVersion?: string;
  nodeType?: string;
  nodes: number;
  endpoint?: string;
  port?: number;
  securityGroups: string[];
  arn?: string;
  kmsKeyId?: string;
  memberClusters?: string[]; // replication group members (CC-22: each is an alias of the group)
  vpcId?: string;
  subnetIds?: string[];
  subnetGroup?: string;
  createdAt?: number;
  transitEncryption?: boolean;
  atRestEncryption?: boolean;
  authToken?: boolean; // AUTH enabled (never the token)
  tags?: Record<string, string>;
  snapshotRetentionDays?: number; // SnapshotRetentionLimit
  snapshotWindow?: string;
  maintenanceWindow?: string; // from a member cluster
  parameterGroup?: string; // from a member cluster
  automaticFailover?: string; // enabled | disabled | enabling | disabling
  multiAz?: boolean;
}

export interface RawSecurityGroup {
  id: string;
  name: string;
  vpcId?: string;
  inbound: { fromPort?: number; toPort?: number; groups: string[]; cidrs?: string[]; prefixLists?: string[]; description?: string }[];
}

export interface RawTargetHealth {
  targetGroupArn: string;
  healthy: number;
  unhealthy: number;
  initial?: number; // registering, health not settled yet
  draining?: number;
  reasons: string[];
}

export interface RawRevision {
  arn: string;
  revision: number;
  image: string;
  registeredAt?: number;
  status: "ACTIVE" | "INACTIVE";
  containers?: { name: string; image: string; essential?: boolean }[]; // every container, for image checks (R24)
}

export interface RawEvent {
  id: string;
  at: number;
  message: string;
}

// ---------- status derivation input ----------

export interface ProbeResult {
  url: string;
  pass: boolean;
  consecutiveFailures: number;
  status?: number;
  ms?: number;
  error?: string;
}

export type Fetched<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Signals {
  runtime: Fetched<RawService>;
  probe?: ProbeResult; // undefined = no probe for this service
  targets?: RawTargetHealth[]; // undefined = not behind a load balancer
  box?: Fetched<RawBox | null>; // ECS-on-EC2 services only: the host they run on
  fetchedAt: number;
}

export interface Derived {
  state: State;
  reasons: string[];
}

// ---------- views ----------

export type EditKind = "desired" | "revision" | "power";

export interface PropertyItem {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
  href?: string;
  tone?: "ok" | "warn" | "bad" | "muted";
  edit?: EditKind;
}

export interface PropertyGroup {
  title: string;
  items: PropertyItem[];
}

export interface ActionSpec {
  name: ActionName | "boxStart" | "boxStop";
  label: string;
  enabled: boolean;
  why?: string; // shown when disabled
  danger?: boolean;
  warning?: string; // enabled, but say this first ("probably denied by IAM", "autoscaling overrides the count")
}

// What a guarded action returns. "AWS accepted" is not "done": verification follows (REVIEW, durable operations).
export interface ActionResult {
  ok: true;
  requestId: string;
  operationId?: string;
  verification?: "accepted" | "verified" | "failed" | "unknown";
}

export interface CommitInfo {
  sha: string;
  title: string;
  author: string;
  date: string;
  url: string;
}

export interface ResourceView {
  key: string; // "<kind>:<id>" — unique within an env
  kind: ResourceKind;
  env: EnvName;
  id: string;
  name: string;
  subtitle: string;
  state: State;
  reasons: string[];
  checkedAt: number;
  sha?: string;
  commit?: CommitInfo;
  behindBy?: number;
  stats: { label: string; value: string }[];
  spark?: number[]; // cpu % last hour, for cards
  properties: PropertyGroup[];
  actions: ActionSpec[];
  tabs: ("overview" | "revisions" | "variables" | "events" | "logs" | "metrics" | "containers")[];
  repo?: string;
  readOnly?: boolean;
  uptime?: UptimeView;
  infra?: boolean; // supporting service (proxy, cache) rather than an app, from discovery metadata (F38)
  fetchedAt?: number; // when the data behind `state` was read (per tile, R21)
  capacity?: { desired: number; running: number; pending: number; shortfallSince?: number }; // services only (R11)
  autoscaling?: { min: number; max: number; policies: string[] }; // services only (CC-20)
  operations?: OperationNote[]; // recent console changes to this resource, newest first, with their verification
}

// A console change and how far its outcome is known: accepted = AWS accepted it and the sampler is verifying.
export interface OperationNote {
  id: string;
  action: string;
  actor: string;
  at: number;
  verification: "accepted" | "verified" | "failed" | "unknown";
  detail?: string;
}

// A service tile is a ResourceView of kind "service"; the name is kept for the contracts that mention it.
export type ServiceView = ResourceView;

// In-memory state history (since the console process started; bounded to the last 2h).
export interface UptimeView {
  pct: number | null; // share of samples that were UP or intentionally stopped; null = no samples yet
  bars: (State | null)[]; // oldest → newest buckets
  since?: number; // when the current state began, if seen
  windowMs: number;
  coveredMs: number;
  basis?: string; // what the percentage measures (operational state over observed time, not customer availability)
  gapMs?: number; // time inside the window with no observation, excluded from pct
}

export type EdgeKind = "http" | "sql" | "cache" | "stream" | "api";

export interface TopoNode {
  id: string; // resource key ("service:x", "database:y") or virtual ("ext:stripe", "lb:alb")
  label: string;
  sub: string;
  kind: ResourceKind;
  lane: 0 | 1 | 2 | 3 | 4; // default layout column: sources · ingress · services · data · destinations
  state?: State; // undefined for external systems (not monitored)
  resourceKey?: string; // opens the resource panel
  note?: string;
}

export interface TopoEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: EdgeKind;
  source: string; // where this dependency is documented
  rate?: { value: number; unit: string }; // measured traffic, only where a real metric exists
}

export interface EnvOverview {
  env: EnvName;
  checkedAt: number;
  frame: { kind: "box" | "fargate"; title: string; subtitle: string; boxKey?: string };
  services: ResourceView[];
  infra: ResourceView[];
  summary: Record<State, number>;
  source: "aws" | "mock";
  topology: { nodes: TopoNode[]; edges: TopoEdge[] };
  freshness?: Freshness; // age and completeness of this overview as a whole (R21)
  region?: string; // the AWS region this environment's cluster lives in
}

export interface RevisionView {
  arn: string;
  revision: number;
  image: string;
  tag: string;
  sha?: string;
  registeredAt?: number;
  live: boolean;
  imagePresent: boolean;
  commit?: CommitInfo;
  ci?: "success" | "failure" | "cancelled" | "in_progress" | "unknown";
  migrations?: boolean | "unknown"; // vs live revision; "unknown" = the comparison could not be made or was incomplete
  migrationsWhy?: string;
  imageCheck?: "present" | "missing" | "unknown"; // checked per tag/digest for every essential container (R24)
  imageCheckWhy?: string;
  digest?: string; // image digest when known (F68)
  mutableTag?: boolean; // the image is referenced by a tag that can move (latest, v1.2) rather than a sha or digest
  mutableTagWhy?: string;
}

export interface MetricSeries {
  id: string;
  label: string;
  unit: string;
  points: [number, number][]; // [ts, value]
}

// ---------- CI ----------

export interface CiStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt?: string;
  completedAt?: string;
}

export interface CiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt?: string;
  completedAt?: string;
  steps: CiStep[];
  url: string;
}

export interface CiRun {
  id: number;
  repo: string;
  workflow: string;
  branch: string;
  sha: string;
  title: string;
  actor: string;
  event: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  workflowPath?: string; // ".github/workflows/deploy.yml" — binds a run to a deployment target (R03)
  workflowId?: number;
}

export interface TestCase {
  suite: string;
  name: string;
  seconds: number;
  failure?: string;
  skipped?: boolean;
}

export interface TestReport {
  total: number;
  failed: number;
  skipped: number;
  seconds: number;
  failures: TestCase[];
  files: string[];
}

// ---------- logs ----------

export type LogLine = [ts: number, stream: number, message: string];

export interface InsightsResult {
  status: "Scheduled" | "Running" | "Complete" | "Failed" | "Cancelled" | "Timeout" | "Unknown";
  rows: Record<string, string>[];
  stats?: { recordsMatched: number; recordsScanned: number; bytesScanned: number };
}

export interface ActivityItem {
  id: string;
  at: number;
  kind: "ci" | "deploy" | "ecs" | "action";
  tone: "ok" | "bad" | "warn" | "info";
  title: string;
  detail?: string;
  service?: string;
  env?: EnvName;
  url?: string;
  user?: string;
}

export interface ReleaseCommit {
  sha: string;
  title: string;
  author: string;
  date: string;
}

export interface ReleaseStage {
  env: EnvName;
  label: string;
  protected: boolean;
  sha?: string;
  revision?: number;
  state: State;
}

// One hop in the promotion chain (envs in order): what `to` would get if it took what `from` runs.
export interface ReleaseStep {
  from: EnvName;
  to: EnvName;
  aheadBy?: number;
  behindBy?: number;
  commits: ReleaseCommit[];
  migrations: boolean | "unknown";
  migrationsWhy?: string;
  compareUrl?: string;
  note?: string;
}

export interface ReleaseView {
  service: string;
  name: string;
  repo?: string;
  stages: ReleaseStage[]; // envs where the service runs, in promotion order
  steps: ReleaseStep[]; // consecutive pairs of stages
  note?: string;
}

export interface ObsSeries {
  id: string;
  label: string;
  points: [number, number][];
}

export interface ObsChart {
  id: string;
  title: string;
  unit: string;
  series: ObsSeries[];
  note?: string;
  stepSec?: number; // bucket width; Sum values are normalised per displayed unit (F70)
}

export interface PerfTiles {
  rps: number | null;
  avg: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  errPct: number | null;
  requests: number | null; // total in the window
  errors5xx?: number | null;
  rejected?: number | null; // ELB 503s: requests the load balancer could not route
}

export interface Performance {
  env: EnvName;
  minutes: number;
  source: "alb" | "access-logs" | "none";
  note?: string;
  scopes: { id: string; label: string }[]; // "all" first, then services
  rps: ObsChart; // one series per service + "Total"
  latency: Record<string, ObsChart>; // per scope: avg, p50, p90, p99 (ms)
  errors: ObsChart; // 5xx share of requests, % per service + total
  tiles: Record<string, PerfTiles>; // last ~5 minutes per scope
  rejected?: ObsChart;
  stepSec?: number;
  freshness?: Freshness;
}

export interface RawLbTarget {
  id: string;
  port?: number;
  az?: string;
  state: string; // healthy | unhealthy | initial | draining | unused | unavailable
  reason?: string;
  description?: string;
}

export interface RawLbTargetGroup {
  arn: string;
  name: string;
  port?: number;
  protocol?: string;
  healthPath?: string;
  healthInterval?: number;
  healthyThreshold?: number;
  unhealthyThreshold?: number;
  matcher?: string;
  targets: RawLbTarget[];
}

export interface RawLbRule {
  priority: string;
  hosts: string[];
  paths: string[];
  action: string; // forward | redirect | fixed-response | authenticate-oidc+forward
  targetGroupArn?: string;
}

export interface RawLb {
  arn: string;
  name: string;
  dns: string;
  scheme: string;
  type: string;
  state: string;
  azs: string[];
  createdAt?: number;
  listeners: { port: number; protocol: string; rules: RawLbRule[] }[];
  targetGroups: RawLbTargetGroup[];
}

export interface Observability {
  env: EnvName;
  minutes: number;
  sections: { title: string; charts: ObsChart[] }[];
  deploys: { at: number; service: string; sha?: string; title: string; url?: string; source?: "github" | "ecs"; kind?: "deploy" | "rollback" }[];
  deploysNote?: string;
  freshness?: Freshness;
}

export interface LogPage {
  lines: LogLine[];
  streams: string[];
  cursor: string | null;
  older: string | null;
  truncated?: boolean;
  note?: string;
  streamsTailed?: number;
  streamsTotal?: number;
  scanned?: number; // FilterLogEvents pages read
}

// ---------- audit ----------

export interface AuditEntry {
  at: number;
  phase: "intent" | "result";
  user: string;
  env: EnvName;
  target: string;
  action: string;
  params: Record<string, unknown>;
  reason?: string;
  result?: "ok" | "error" | "unknown"; // unknown = the request may or may not have taken effect (F31)
  detail?: string;
  ip?: string;
  operationId?: string;
  region?: string;
  verify?: "verified" | "failed" | null; // the operation's verification (ECS operations): null = AWS accepted, verifying
  verifyDetail?: string;
}

// The safe fields of an operation record (listOperations): never params, input hashes or results.
export interface OperationView {
  id: string;
  action: string;
  target: string;
  env?: EnvName;
  region?: string;
  actorDisplay: string;
  state: "queued" | "running" | "succeeded" | "failed" | "outcome_unknown" | "cancelled";
  verify?: "verified" | "failed" | null; // null/undefined = not verified yet (or not applicable)
  createdAt: number;
  finishedAt?: number;
  verifiedAt?: number;
  detail?: string;
}

// ---------- capability (F06) ----------

// What the console's AWS identity may do: simulated with iam:SimulatePrincipalPolicy, or learned from real calls.
// UI rule: denied disables the control with a reason, probably-denied warns, unknown shows nothing.
export type CapState = "allowed" | "denied" | "probably-denied" | "unknown";

export interface CapabilityView {
  source: "simulated" | "observed" | "none";
  checkedAt?: number;
  readOnly: boolean; // every ECS write is denied or probably denied
  actions: Record<string, CapState>; // IAM action → state
  denied: string[]; // IAM actions known or likely to be denied
  note?: string;
}
