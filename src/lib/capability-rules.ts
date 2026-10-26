// What the console's AWS identity may do (F06), as pure rules: which IAM actions each console write needs, how a
// simulation result and real-call observations combine into one state, and the worst of several.
// The store and the simulation call live in src/lib/server/capability.ts; the states are typed in types.ts.
import { arnType, parseArn } from "./inventory/arn.ts";
import type { Resource } from "./inventory/types.ts";
import type { CapState } from "./types.ts";

// Console write → the IAM actions it needs. Variable edits also need the write action of each reference they change
// (VAR_REFERENCE_WRITES); a reveal needs the read action of the reference it reveals (VAR_REFERENCE_READS).
export const CONSOLE_WRITES: Record<string, readonly string[]> = {
  "ecs.restart": ["ecs:UpdateService"],
  "ecs.stop": ["ecs:UpdateService"],
  "ecs.start": ["ecs:UpdateService"],
  "ecs.switch": ["ecs:UpdateService"],
  "ecs.scale": ["ecs:UpdateService"],
  "vars.edit": ["ecs:RegisterTaskDefinition", "ecs:UpdateService"],
  "vars.reveal": ["ssm:GetParameter", "secretsmanager:GetSecretValue", "s3:GetObject"],
  "host.power": ["ec2:StartInstances", "ec2:StopInstances"],
  "db.power": ["rds:StartDBInstance", "rds:StopDBInstance"],
  "provision.service": ["ecs:CreateService", "ecs:RegisterTaskDefinition", "iam:PassRole"],
  "provision.task": ["ecs:RunTask", "iam:PassRole"],
  "provision.hosts": ["ec2:RunInstances", "ec2:CreateTags", "iam:PassRole"],
  "provision.delete": ["ecs:DeleteService", "ec2:TerminateInstances"],
};

export type VarReference = "ssm" | "secretsmanager" | "s3";
export const VAR_REFERENCE_WRITES: Record<VarReference, string> = { ssm: "ssm:PutParameter", secretsmanager: "secretsmanager:PutSecretValue", s3: "s3:PutObject" };
export const VAR_REFERENCE_READS: Record<VarReference, string> = { ssm: "ssm:GetParameter", secretsmanager: "secretsmanager:GetSecretValue", s3: "s3:GetObject" };

// Every IAM action above, once each, sorted: what refreshCapability simulates.
export const ALL_WRITE_ACTIONS: readonly string[] = [...new Set([...Object.values(CONSOLE_WRITES).flat(), ...Object.values(VAR_REFERENCE_WRITES)])].sort();
// The ECS writes: when all of them are (probably) denied the console is effectively read-only.
export const ECS_WRITE_ACTIONS: readonly string[] = ALL_WRITE_ACTIONS.filter((a) => a.startsWith("ecs:"));

// The IAM actions one console write needs, including the per-reference action for variables.
export function actionsFor(write: string, refs: VarReference[] = []): string[] {
  const base = Object.hasOwn(CONSOLE_WRITES, write) ? [...CONSOLE_WRITES[write]] : [];
  if (write === "vars.edit") for (const r of refs) base.push(VAR_REFERENCE_WRITES[r]);
  if (write === "vars.reveal" && refs.length) return [...new Set(refs.map((r) => VAR_REFERENCE_READS[r]))];
  return [...new Set(base)];
}

// sts:GetCallerIdentity returns the session ("arn:aws:sts::123456789012:assumed-role/acme-console/i-0abc"); the IAM
// simulator wants the role ("arn:aws:iam::123456789012:role/acme-console"). A role path cannot be recovered from a
// session ARN, so a role under a path must be configured explicitly. Users and roles are returned unchanged.
export function roleArnFromCaller(arn: string): string {
  const m = arn.match(/^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/);
  return m ? `arn:${m[1]}:iam::${m[2]}:role/${m[3]}` : arn;
}

// Why a policy simulation verified nothing, for Settings → AWS permissions. A role under an IAM path ("/service-role/…")
// can't be named from its session ARN (roleArnFromCaller drops the path), so IAM answers NoSuchEntity for the
// path-less role: harmless, real calls still teach, but say so in plain words.
export function simulationFailureNote(e: { name?: unknown; message?: unknown } | undefined, text: string): string {
  const name = typeof e?.name === "string" ? e.name : "";
  const msg = typeof e?.message === "string" ? e.message : "";
  if (name === "NoSuchEntity" || name === "NoSuchEntityException" || /NoSuchEntity/.test(msg)) {
    return "not verified: the console's role is under an IAM path, which its session doesn't show, so its policy can't be simulated (real calls still show what is refused)";
  }
  return `not verified: ${text}`;
}

// resourceDeny: an implicit deny simulated against a real resource with no missing context values, for a service
// without resource policies (denialIsFinal) — nothing the simulator can't see could still grant it (SCPs and permission
// boundaries only take away), so it is a denial, not a "probably".
export type SimDecision = "allowed" | "implicitDeny" | "explicitDeny" | "resourceDeny";

// Services without resource-based policies (AWS: "AWS services that work with IAM"). Elsewhere a Lambda function, SQS
// queue, SNS topic, S3 bucket or EventBridge bus can carry a policy of its own that grants what the console's policy
// doesn't, and the simulation doesn't read those: there an implicit deny on a real resource stays a "probably".
const NO_RESOURCE_POLICIES = new Set(["ecs", "ec2", "autoscaling", "rds", "elasticbeanstalk", "apprunner", "cloudfront", "states"]);
export const denialIsFinal = (action: string): boolean => NO_RESOURCE_POLICIES.has(action.slice(0, action.indexOf(":")));

export interface Evidence {
  simulated?: SimDecision; // iam:SimulatePrincipalPolicy (resource "*" or a real one — simulationTargets — no context)
  deniedAt?: number; // a real call was refused (AccessDenied) at this time
  allowedAt?: number; // a real call succeeded at this time
}

export const OBSERVED_TTL_MS = 10 * 60_000;

// An observed refusal wins while it is fresh; an explicit deny is final; a real success outranks a simulated implicit
// deny (resource policies and conditions the simulator can't see); an implicit deny is only "probably".
export function decide(e: Evidence | undefined, now: number, ttlMs: number = OBSERVED_TTL_MS): CapState {
  if (!e) return "unknown";
  const fresh = (at: number | undefined) => at !== undefined && now - at < ttlMs;
  const denied = fresh(e.deniedAt) && !(fresh(e.allowedAt) && e.allowedAt! > e.deniedAt!);
  if (denied) return "denied";
  if (e.simulated === "explicitDeny") return "denied";
  if (fresh(e.allowedAt)) return "allowed";
  if (e.simulated === "resourceDeny") return "denied";
  if (e.simulated === "implicitDeny") return "probably-denied";
  if (e.simulated === "allowed") return "allowed";
  return "unknown";
}

const RANK: Record<CapState, number> = { denied: 0, "probably-denied": 1, unknown: 2, allowed: 3 };

// The worst of several states (an action needing three IAM actions is as capable as its weakest one). None → allowed.
export function combine(states: CapState[]): CapState {
  return states.reduce<CapState>((w, s) => (RANK[s] < RANK[w] ? s : w), "allowed");
}

// ---------- what to simulate against (F06) ----------

// ECS actions whose IAM resource is a service. A policy scoped to arn:…:service/*/* (the console's own recommended one)
// is an implicit deny for resource "*" but allowed for a real service, so these are simulated against one.
export const SERVICE_SCOPED_ACTIONS: readonly string[] = ["ecs:CreateService", "ecs:DeleteService", "ecs:UpdateService"];
// ECS actions whose IAM resource is a task definition (a new revision of the family, for RegisterTaskDefinition).
export const TASK_DEFINITION_ACTIONS: readonly string[] = ["ecs:RegisterTaskDefinition", "ecs:RunTask"];

// Writes outside ECS whose IAM resource is the resource they act on, by its ARN type (arnType). The rest stay against
// "*": RunInstances, CreateTags and PassRole name resources the request creates or picks, and S3 objects, API Gateway
// paths and EKS nodegroups aren't inventory resources.
export const RESOURCE_TYPED_ACTIONS: Readonly<Record<string, string>> = {
  "ec2:StartInstances": "ec2:instance", "ec2:StopInstances": "ec2:instance", "ec2:RebootInstances": "ec2:instance", "ec2:TerminateInstances": "ec2:instance",
  "rds:StartDBInstance": "rds:db", "rds:StopDBInstance": "rds:db",
  "autoscaling:SetDesiredCapacity": "autoscaling:autoScalingGroup",
  "elasticbeanstalk:UpdateEnvironment": "elasticbeanstalk:environment", "elasticbeanstalk:RestartAppServer": "elasticbeanstalk:environment",
  "apprunner:StartDeployment": "apprunner:service", "apprunner:PauseService": "apprunner:service", "apprunner:ResumeService": "apprunner:service",
  "cloudfront:CreateInvalidation": "cloudfront:distribution",
  "states:StartExecution": "states:stateMachine",
  "events:EnableRule": "events:rule", "events:DisableRule": "events:rule",
  "lambda:UpdateFunctionCode": "lambda:function", "lambda:PublishVersion": "lambda:function", "lambda:UpdateAlias": "lambda:function",
  "lambda:InvokeFunction": "lambda:function", "lambda:PutFunctionConcurrency": "lambda:function", "lambda:DeleteFunctionConcurrency": "lambda:function",
  "lambda:UpdateFunctionConfiguration": "lambda:function",
  "sqs:SendMessage": "sqs:queue", "sqs:StartMessageMoveTask": "sqs:queue", "sqs:PurgeQueue": "sqs:queue",
  "sns:Publish": "sns:topic",
};
const SAMPLED_TYPES = new Set(Object.values(RESOURCE_TYPED_ACTIONS));
const PLACES_PER_TYPE = 5;

export interface SimulationCluster {
  cluster: string;
  clusterArn?: string;
  services: { name: string; family?: string; taskDefinitionArn?: string }[];
}

// What simulationTargets reads of a cloud-map inventory row.
export type SampleRow = Pick<Resource, "key" | "aliases" | "region" | "env" | "tags" | "tagsUnread" | "source" | "facts" | "account">;

// A row's own ARN: its key, or for the console's keys (ec2:i-…, rds:…) its alias ARN of the same service.
function ownArn(r: SampleRow): string | undefined {
  if (r.key.startsWith("arn:")) return r.key;
  const service = r.key.slice(0, r.key.indexOf(":"));
  return r.aliases?.find((a) => parseArn(a)?.service === service);
}

// The real resources to simulate each action against. ECS: in every cluster, the first service that isn't the
// console's own (and its task definition). Other writes (RESOURCE_TYPED_ACTIONS): in every environment and region of
// the inventory, the first resource of the action's type — never one tagged console:self or the CONSOLE_SELF_INSTANCE
// instance (`selfInstance`), nor one whose tags weren't read or that another account owns. One per cluster or
// environment because policies are narrowed that way (service/acme-staging/*, acme-staging-* names). An action with no
// target is simulated against "*", and so is a type found in more than PLACES_PER_TYPE places. A policy scoped by name
// within one cluster or environment can still be misjudged by the sample; simulating every resource would settle it,
// at one IAM call per resource.
export function simulationTargets(clusters: SimulationCluster[], self?: { cluster: string; family: string }, rows: SampleRow[] = [], selfInstance?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (action: string, arn: string) => (out[action] ??= []).push(arn);
  for (const c of clusters) {
    const m = /^arn:(aws[\w-]*):ecs:([a-z0-9-]+):(\d{12}):cluster\/(.+)$/.exec(c.clusterArn ?? "");
    if (!m) continue;
    const s = c.services.find((x) => !(self && self.cluster === c.cluster && x.family === self.family));
    if (!s) continue;
    for (const a of SERVICE_SCOPED_ACTIONS) add(a, `arn:${m[1]}:ecs:${m[2]}:${m[3]}:service/${m[4]}/${s.name}`);
    if (s.taskDefinitionArn?.startsWith("arn:")) for (const a of TASK_DEFINITION_ACTIONS) add(a, s.taskDefinitionArn);
  }
  const places = new Map<string, Map<string, string>>(); // ARN type → "env@region" → the first ARN there
  for (const r of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (r.tagsUnread || r.account || r.source === "reference" || r.facts?.remote === true) continue;
    if (/^true$/i.test(r.tags?.["console:self"]?.trim() ?? "")) continue; // isSelfTagged (action-rules.ts isn't client-safe)
    const arn = ownArn(r);
    const p = arn ? parseArn(arn) : undefined;
    const type = p ? arnType(p) : "";
    if (!arn || !p || !SAMPLED_TYPES.has(type) || (selfInstance && arn.endsWith(`:instance/${selfInstance}`))) continue;
    const byPlace = places.get(type) ?? new Map<string, string>();
    places.set(type, byPlace);
    const place = `${r.env ?? ""}@${p.region || r.region}`;
    if (!byPlace.has(place)) byPlace.set(place, arn);
  }
  for (const [action, type] of Object.entries(RESOURCE_TYPED_ACTIONS)) {
    const byPlace = places.get(type);
    if (byPlace && byPlace.size <= PLACES_PER_TYPE) for (const arn of byPlace.values()) add(action, arn);
  }
  return out;
}

// One action simulated against several resources is allowed, or denied, only when every one agrees. A mix (a policy
// scoped to some clusters or environments) stays a "probably", as it was against "*".
export function combineTargets(ds: SimDecision[]): SimDecision | undefined {
  if (!ds.length) return undefined;
  if (ds.every((d) => d === "allowed")) return "allowed";
  if (ds.every((d) => d === "explicitDeny")) return "explicitDeny";
  if (ds.every((d) => d === "explicitDeny" || d === "resourceDeny")) return "resourceDeny";
  return "implicitDeny";
}
