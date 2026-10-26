// What the console's AWS identity may do (F06), as pure rules: which IAM actions each console write needs, how a
// simulation result and real-call observations combine into one state, and the worst of several.
// The store and the simulation call live in src/lib/server/capability.ts; the states are typed in types.ts.
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

// resourceDeny: an implicit deny simulated against a real resource with no missing context values — nothing the
// simulator can't see could still grant it for these actions (ECS has no resource policies; SCPs and permission
// boundaries only take away), so it is a denial, not a "probably".
export type SimDecision = "allowed" | "implicitDeny" | "explicitDeny" | "resourceDeny";

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

export interface SimulationCluster {
  cluster: string;
  clusterArn?: string;
  services: { name: string; family?: string; taskDefinitionArn?: string }[];
}

// The real resources to simulate each action against: in every cluster, the first service that isn't the console's
// own (and its task definition, for ecs:RunTask). One per cluster because the documented narrowing scopes these
// actions by cluster (service/acme-staging/*). An action with no target is simulated against "*". A policy scoped by
// service name rather than cluster can still be misjudged by the sample; simulating every service would settle it, at
// one IAM call per service.
export function simulationTargets(clusters: SimulationCluster[], self?: { cluster: string; family: string }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (action: string, arn: string) => (out[action] ??= []).push(arn);
  for (const c of clusters) {
    const m = /^arn:(aws[\w-]*):ecs:([a-z0-9-]+):(\d{12}):cluster\/(.+)$/.exec(c.clusterArn ?? "");
    if (!m) continue;
    const s = c.services.find((x) => !(self && self.cluster === c.cluster && x.family === self.family));
    if (!s) continue;
    for (const a of SERVICE_SCOPED_ACTIONS) add(a, `arn:${m[1]}:ecs:${m[2]}:${m[3]}:service/${m[4]}/${s.name}`);
    if (s.taskDefinitionArn?.startsWith("arn:")) add("ecs:RunTask", s.taskDefinitionArn);
  }
  return out;
}

// One action simulated against several resources is allowed, or denied, only when every one agrees. A mix (a policy
// scoped to some clusters) stays a "probably", as it was against "*".
export function combineTargets(ds: SimDecision[]): SimDecision | undefined {
  if (!ds.length) return undefined;
  if (ds.every((d) => d === "allowed")) return "allowed";
  if (ds.every((d) => d === "explicitDeny")) return "explicitDeny";
  if (ds.every((d) => d === "explicitDeny" || d === "resourceDeny")) return "resourceDeny";
  return "implicitDeny";
}
