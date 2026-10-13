// Simulated compute state of the Acme account beyond ECS (names from ../mock-names.ts): a bastion, a long-stopped legacy
// cron box, the EKS data platform (nodegroup "general" → EC2 nodes behind an Auto Scaling group, two ML workloads and an
// ingress), the App Runner staging preview and the legacy admin on Elastic Beanstalk (instance + ASG).
// On globalThis like ../../mock.ts, so the routes and the sampler share one copy; actions move it through time-based
// transitions (pending → running after 12 s, …). The staging ECS host is ../../mock.ts's own and isn't repeated here.
import { ACCT, BEANSTALK, EC2, ECR_REPOS, EKS, EXISTING, NETWORK, REGION, SECURITY_GROUPS, ecrImage } from "../mock-names.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const MOCK_REGION = REGION;
export const TRANSITION_MS = 12_000;

export interface MInstance {
  id: string;
  type: string;
  state: string;
  since: number; // entered the current state
  to?: string; // state after `at`
  at?: number;
  reason?: string; // StateTransitionReason
  launchedAt: number;
  tags: Record<string, string>;
  vpcId: string;
  subnetId: string;
  sgs: string[];
  privateIp: string;
  publicIp?: string; // only while running
  eip?: string; // stays across stop/start
  profile?: string;
  platform: string;
  ami: string;
  az: string;
  rebootUntil?: number;
}

export interface MWorkload { kind: "Deployment" | "StatefulSet"; replicas: number; prev: number; changedAt: number; restartedAt?: number }
export interface MOp { id: string; type: string; status: string; startedAt: number; endedAt?: number }
export interface MEvent { at: number; severity: string; message: string }

interface State {
  t0: number;
  instances: Map<string, MInstance>;
  reboots: Map<string, number>; // hosts simulated elsewhere (the ECS staging host): rebooting until
  nodegroup: { min: number; desired: number; max: number; status: string; at: number; updates: { id: string; at: number; params: string }[] };
  workloads: Map<string, MWorkload>; // "<namespace>/<name>"
  apprunner: { status: string; to?: string; at: number; ops: MOp[] };
  beanstalk: { status: string; to?: string; at: number; version: string; next?: string; health: string; healthStatus: string; cause?: string; events: MEvent[] };
}

// ---------- fixed facts ----------

export const EKS_ENDPOINT = "https://6E1D2C3B4A59687706F5E4D3C2B1A0F9.gr7.us-east-1.eks.amazonaws.com";
export const EKS_SG = "sg-eks-acme-data";
export const NODE_ASG = "eks-general-7ac9d2e1-3b4f-4c1a-9e1b-0a1b2c3d4e5f";
export const NODE_ASG_ARN = `arn:aws:autoscaling:${REGION}:${ACCT}:autoScalingGroup:5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d:autoScalingGroupName/${NODE_ASG}`;
export const EB_ASG = `awseb-${BEANSTALK.env.id}-stack-AWSEBAutoScalingGroup-1A2B3C4D5E6F`;
export const EB_ASG_ARN = `arn:aws:autoscaling:${REGION}:${ACCT}:autoScalingGroup:9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5:autoScalingGroupName/${EB_ASG}`;
export const EB_INSTANCE = "i-0acmeebadmin0001";
export const EB_EIP = "203.0.113.25";
export const EB_ARN = `arn:aws:elasticbeanstalk:${REGION}:${ACCT}:environment/${BEANSTALK.app}/${BEANSTALK.env.name}`;
export const EB_PLATFORM = "64bit Amazon Linux 2023 v6.6.2 running Node.js 22";
export const EB_VERSIONS = [
  { label: "v43", description: "fix: admin export 5xx on large orders", ageDays: 2 },
  { label: "v42", description: "feat: refund notes", ageDays: 34 },
  { label: "v41", description: "chore: node 22", ageDays: 61 },
];
export const RECOMMENDER_LB = `k8s-ml-recommender-0123456789.${REGION}.elb.amazonaws.com`;
export const PREVIEW_IMAGE = ecrImage(ECR_REPOS.storefrontApi.name, "staging-4f1c2d9"); // the storefront's own repository
const nodeId = (k: number) => `i-0acmeeksnode${String(k).padStart(4, "0")}`;

// ---------- state ----------

function init(): State {
  const t0 = Date.now();
  const instances = new Map<string, MInstance>();
  const add = (i: MInstance) => instances.set(i.id, i);
  add({
    id: EC2.bastion.id, type: EC2.bastion.type, state: "running", since: t0 - 41 * DAY, launchedAt: t0 - 41 * DAY, tags: { Name: EC2.bastion.name, Role: "bastion" },
    // Production's first public subnet and the bastion group the network simulations hold (its interface: 10.20.0.20).
    vpcId: NETWORK.production.vpc, subnetId: NETWORK.production.publicSubnets[0], sgs: [SECURITY_GROUPS.bastion.id], privateIp: "10.20.0.20", eip: EC2.bastion.publicIp,
    profile: `arn:aws:iam::${ACCT}:instance-profile/acme-bastion`, platform: "Linux/UNIX", ami: "ami-0b1c2d3e4f5a6b7c8", az: `${REGION}a`,
  });
  const cronStopped = t0 - 120 * DAY;
  add({
    id: EC2.legacyCron.id, type: EC2.legacyCron.type, state: "stopped", since: cronStopped, launchedAt: cronStopped - 400 * DAY,
    reason: `User initiated (${new Date(cronStopped).toISOString().slice(0, 19).replace("T", " ")} GMT)`,
    tags: { Name: EC2.legacyCron.name, Environment: EC2.legacyCron.env }, vpcId: EXISTING.vpc.production, subnetId: EXISTING.subnets.production[1],
    sgs: ["sg-prod-legacy-cron"], privateIp: "10.0.2.77", platform: "Linux/UNIX", ami: "ami-0123legacy4567890", az: `${REGION}b`,
  });
  add({
    id: EB_INSTANCE, type: "t3.small", state: "running", since: t0 - 9 * DAY, launchedAt: t0 - 9 * DAY,
    tags: {
      Name: BEANSTALK.env.name, "elasticbeanstalk:environment-name": BEANSTALK.env.name, "elasticbeanstalk:environment-id": BEANSTALK.env.id,
      "aws:autoscaling:groupName": EB_ASG, "aws:cloudformation:stack-name": `awseb-${BEANSTALK.env.id}-stack`,
    },
    vpcId: EXISTING.vpc.production, subnetId: EXISTING.subnets.production[0], sgs: ["sg-prod-legacy-admin"], privateIp: "10.0.1.58", eip: EB_EIP,
    profile: `arn:aws:iam::${ACCT}:instance-profile/aws-elasticbeanstalk-ec2-role`, platform: "Linux/UNIX", ami: "ami-0eb2023node22abcd", az: `${REGION}a`,
  });
  const s: State = {
    t0, instances, reboots: new Map(),
    nodegroup: { min: 1, desired: EKS.nodegroup.desired, max: 4, status: "ACTIVE", at: 0, updates: [] },
    workloads: new Map(EKS.workloads.map((w) => [`${w.namespace}/${w.name}`, { kind: w.kind as MWorkload["kind"], replicas: w.replicas, prev: w.replicas, changedAt: 0 }])),
    apprunner: { status: "RUNNING", at: 0, ops: [{ id: "op-0acme1", type: "START_DEPLOYMENT", status: "SUCCEEDED", startedAt: t0 - 5 * 3_600_000, endedAt: t0 - 5 * 3_600_000 + 4 * MIN }] },
    beanstalk: {
      status: "Ready", at: 0, version: "v42", health: "Yellow", healthStatus: "Warning", cause: "12 % of requests to the instance are failing with HTTP 5xx",
      events: [
        { at: t0 - 34 * DAY, severity: "INFO", message: "Environment update completed successfully." },
        { at: t0 - 3 * 3_600_000, severity: "WARN", message: "Environment health has transitioned from Ok to Warning. 12 % of the requests are failing with HTTP 5xx." },
      ],
    },
  };
  for (let k = 1; k <= s.nodegroup.desired; k++) instances.set(nodeId(k), node(k, "running", t0 - 18 * DAY));
  return s;
}

function node(k: number, state: string, since: number): MInstance {
  return {
    id: nodeId(k), type: EKS.nodegroup.instanceType, state, since, launchedAt: since,
    tags: {
      Name: `${EKS.cluster.name}-${EKS.nodegroup.name}`, "eks:cluster-name": EKS.cluster.name, "eks:nodegroup-name": EKS.nodegroup.name,
      "aws:autoscaling:groupName": NODE_ASG, [`kubernetes.io/cluster/${EKS.cluster.name}`]: "owned",
    },
    vpcId: EXISTING.vpc.production, subnetId: EXISTING.subnets.production[(k - 1) % 2], sgs: [EKS_SG], privateIp: `10.0.${10 + ((k - 1) % 2)}.${40 + k}`,
    profile: `arn:aws:iam::${ACCT}:instance-profile/eks-general-node`, platform: "Linux/UNIX", ami: "ami-0eksal2023x86abcd", az: `${REGION}${(k - 1) % 2 ? "b" : "a"}`,
  };
}

const g = globalThis as { __consoleComputeMock?: State };
export function mockState(): State {
  const s = (g.__consoleComputeMock ??= init());
  tick(s, Date.now());
  return s;
}

function tick(s: State, now: number) {
  for (const [id, i] of s.instances) {
    if (!i.to || now < (i.at ?? 0)) continue;
    if (i.to === "terminated") {
      s.instances.delete(id);
      continue;
    }
    Object.assign(i, { state: i.to, since: i.at, to: undefined, at: undefined });
    if (i.state === "running") Object.assign(i, { launchedAt: i.since, reason: undefined });
  }
  const ng = s.nodegroup;
  if (ng.status === "UPDATING" && now >= ng.at) {
    ng.status = "ACTIVE";
    // The nodegroup's ASG converges: new nodes boot, surplus ones terminate.
    const nodes = [...s.instances.values()].filter((i) => i.tags["eks:nodegroup-name"] && i.to !== "terminated").sort((a, b) => a.id.localeCompare(b.id));
    for (let k = nodes.length + 1; k <= ng.desired; k++) {
      let n = 1;
      while (s.instances.has(nodeId(n))) n++;
      s.instances.set(nodeId(n), { ...node(n, "pending", ng.at), to: "running", at: ng.at + 15_000 });
    }
    for (const x of nodes.slice(ng.desired)) Object.assign(x, { state: "shutting-down", to: "terminated", at: ng.at + 10_000 });
    tick(s, now);
  }
  const ar = s.apprunner;
  if (ar.to && now >= ar.at) {
    ar.status = ar.to;
    ar.to = undefined;
    for (const op of ar.ops) if (op.status === "IN_PROGRESS") Object.assign(op, { status: "SUCCEEDED", endedAt: ar.at });
  }
  const eb = s.beanstalk;
  if (eb.to && now >= eb.at) {
    eb.status = eb.to;
    eb.to = undefined;
    if (eb.next) {
      eb.version = eb.next;
      eb.next = undefined;
      eb.events.push({ at: eb.at, severity: "INFO", message: `Environment update completed successfully. New application version ${eb.version} deployed.` });
    } else eb.events.push({ at: eb.at, severity: "INFO", message: "restartAppServer completed successfully." });
    Object.assign(eb, { health: "Green", healthStatus: "Ok", cause: undefined });
  }
}

// ---------- actions (callers validate first) ----------

export function mockPower(id: string, action: "start" | "stop" | "reboot") {
  const s = mockState();
  const i = s.instances.get(id);
  const now = Date.now();
  if (!i) {
    if (action !== "reboot") throw Object.assign(new Error(`InvalidInstanceID.NotFound: ${id}`), { name: "InvalidInstanceID.NotFound" });
    s.reboots.set(id, now + 20_000); // start/stop of those go through their own simulation
    return { instanceId: id, requestId: `mock-${now.toString(36)}` };
  }
  if (action === "reboot") i.rebootUntil = now + 20_000;
  else if (action === "start") Object.assign(i, { state: "pending", since: now, to: "running", at: now + TRANSITION_MS });
  else Object.assign(i, { state: "stopping", since: now, to: "stopped", at: now + TRANSITION_MS, reason: `User initiated (${new Date(now + TRANSITION_MS).toISOString().slice(0, 19).replace("T", " ")} GMT)` });
  return { instanceId: id, requestId: `mock-${now.toString(36)}` };
}

export function mockScaleNodegroup(min: number, desired: number, max: number) {
  const s = mockState();
  const now = Date.now();
  const id = `mock-update-${now.toString(36)}`;
  Object.assign(s.nodegroup, { min, desired, max, status: "UPDATING", at: now + 20_000 });
  s.nodegroup.updates.unshift({ id, at: now, params: `min ${min}, desired ${desired}, max ${max}` });
  return { updateId: id };
}

export function mockWorkload(ns: string, name: string) {
  const w = mockState().workloads.get(`${ns}/${name}`);
  if (!w) throw Object.assign(new Error(`NotFound: ${ns}/${name}`), { status: 404 });
  return w;
}

export function mockApprunner(op: "START_DEPLOYMENT" | "PAUSE_SERVICE" | "RESUME_SERVICE") {
  const s = mockState();
  const now = Date.now();
  const id = `op-${now.toString(36)}`;
  s.apprunner.ops.unshift({ id, type: op, status: "IN_PROGRESS", startedAt: now });
  Object.assign(s.apprunner, { status: "OPERATION_IN_PROGRESS", to: op === "PAUSE_SERVICE" ? "PAUSED" : "RUNNING", at: now + (op === "START_DEPLOYMENT" ? 25_000 : 10_000) });
  return { operationId: id };
}

export function mockBeanstalk(op: { deploy: string } | { restart: true }) {
  const s = mockState();
  const now = Date.now();
  const eb = s.beanstalk;
  Object.assign(eb, { status: "Updating", to: "Ready", at: now + ("deploy" in op ? 25_000 : 10_000), next: "deploy" in op ? op.deploy : undefined });
  eb.events.push({ at: now, severity: "INFO", message: "deploy" in op ? `Environment update is starting (version ${op.deploy}).` : "restartAppServer is starting." });
  return { requestId: `mock-${now.toString(36)}` };
}

