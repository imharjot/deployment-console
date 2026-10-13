// One precedence table turns raw signals into a state. First matching rule wins.
// Rule: never report UP while any applicable signal is failing.
import { LIMITS } from "./config.ts";
import { shaFromTag } from "./discover.ts";
import type { Derived, Fetched, ProbeResult, RawBox, Signals, State } from "./types.ts";

const probeFailing = (s: Signals) => !!s.probe && s.probe.consecutiveFailures >= LIMITS.probeFailuresToFail;

// Capacity input (R11): when this service's running count first fell short of desired with no rollout (the sampler
// keeps it per service), and how long a shortfall may last before it degrades the service.
export interface DeriveOptions {
  shortfallSince?: number; // undefined = first sight of a shortfall (still within the grace period)
  graceMs?: number; // default LIMITS.capacityGraceMs
}

export function deriveState(s: Signals, now: number, o: DeriveOptions = {}): Derived {
  // 1. UNKNOWN — the runtime source (or the EC2 host behind an ECS-on-EC2 service) can't be read, or the data is stale.
  if (!s.runtime.ok) return { state: "UNKNOWN", reasons: [`runtime: ${s.runtime.error}`] };
  if (s.box && !s.box.ok) return { state: "UNKNOWN", reasons: [`box: ${s.box.error}`] };
  if (!(s.fetchedAt > 0)) return { state: "UNKNOWN", reasons: ["data freshness unknown"] };
  if (now - s.fetchedAt > LIMITS.staleMs) {
    return { state: "UNKNOWN", reasons: [`data is ${Math.round((now - s.fetchedAt) / 1000)}s old`] };
  }

  const svc = s.runtime.value;

  // 2. BOX_STOPPED — the EC2 host is not running; its services are not "down", they are parked.
  if (s.box?.ok && (!s.box.value || s.box.value.state !== "running")) {
    return { state: "BOX_STOPPED", reasons: [`box is ${s.box.value?.state ?? "missing"}`] };
  }

  // 3. STOPPED — desired 0 is intentional.
  if (svc.desired === 0) return { state: "STOPPED", reasons: ["desired count is 0"] };

  const inProgress = svc.deployments.find((d) => d.rolloutState === "IN_PROGRESS");
  const failed = svc.deployments
    .filter((d) => d.rolloutState === "FAILED" && now - d.updatedAt < LIMITS.failedDeployWindowMs)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  // 4. DEPLOYING — a rollout under 15 minutes old, or a freshly started EC2 host whose tasks are still being placed.
  const boxAge = s.box?.ok && s.box.value?.launchedAt ? now - s.box.value.launchedAt : Infinity;
  if (svc.running === 0 && boxAge < LIMITS.boxBootGraceMs) {
    return { state: "DEPLOYING", reasons: [`box started ${Math.floor(boxAge / 60_000)}m ago — ECS placing tasks`] };
  }
  if (inProgress && now - inProgress.createdAt < LIMITS.deployStuckMs) {
    const mins = Math.max(0, Math.floor((now - inProgress.createdAt) / 60_000));
    return { state: "DEPLOYING", reasons: [`rollout in progress (${mins}m)`] };
  }

  const running = svc.tasks.filter((t) => t.lastStatus === "RUNNING");
  const anyHealthy = running.some((t) => t.health === "HEALTHY" || !t.hasHealthcheck);
  // ECS counts running tasks but their details didn't come back (a capped or failed DescribeTasks, F29): judge by the
  // other signals and never call it "no running task".
  const detailsMissing = running.length === 0;
  // Only some of the running tasks were listed (the cluster's RUNNING listing hit its page cap, R13): the healthy ones
  // may be among those not read, so the task list can't prove that none is healthy.
  const partialTasks = svc.tasksComplete === false;

  // 5. DOWN — nothing running, or the public probe fails and no task reports healthy.
  if (svc.running === 0) {
    const last = svc.tasks.find((t) => t.stoppedReason)?.stoppedReason;
    return { state: "DOWN", reasons: ["no running task", ...(last ? [`last stop: ${last}`] : [])] };
  }
  if (probeFailing(s) && !anyHealthy && !detailsMissing && !partialTasks) {
    return { state: "DOWN", reasons: [`probe failing: ${s.probe!.error ?? `HTTP ${s.probe!.status}`}`] };
  }

  // 6. DEGRADED — running, but something applicable is failing, or capacity has been short past the grace period.
  const cap = capacityState({ desired: svc.desired, running: svc.running, pending: svc.pending, rollout: !!inProgress }, o.shortfallSince, now, o.graceMs ?? LIMITS.capacityGraceMs);
  const reasons: string[] = [];
  if (cap.state === "short") reasons.push(cap.reason!);
  if (running.some((t) => t.health === "UNHEALTHY")) reasons.push("container health check UNHEALTHY");
  else if (running.some((t) => t.hasHealthcheck && t.health === "UNKNOWN")) reasons.push("health check not reported yet");
  if (probeFailing(s)) reasons.push(`probe failing: ${s.probe!.error ?? `HTTP ${s.probe!.status}`}`);
  for (const tg of s.targets ?? []) {
    if (tg.unhealthy > 0 || tg.healthy === 0) reasons.push(`load balancer: ${tg.healthy} healthy / ${tg.unhealthy} unhealthy`);
  }
  if (inProgress) reasons.push(`rollout stuck for ${Math.floor((now - inProgress.createdAt) / 60_000)}m`);
  if (failed) reasons.push(`last rollout failed and was rolled back${failed.rolloutReason ? `: ${failed.rolloutReason}` : ""}`);
  if (reasons.length) return { state: "DEGRADED", reasons: cap.state === "starting" ? [...reasons, cap.reason!] : reasons };

  // 7. UP — a shortfall still inside its grace period keeps UP but says so ("starting (1/5 running)").
  const probeNote = s.probe ? [`probe ${s.probe.status ?? 200} in ${s.probe.ms ?? "?"}ms`] : [];
  const head = cap.state === "starting" ? cap.reason! : detailsMissing ? `${svc.running}/${svc.desired} running (task details unavailable)` : `${svc.running}/${svc.desired} running, healthy`;
  return { state: "UP", reasons: [head, ...(cap.state === "starting" && detailsMissing ? ["task details unavailable"] : []), ...probeNote] };
}

// A docker compose workload (console.config.json `workloads`) on its env's EC2 box. AWS can't see the containers, so
// the box decides first, then the workload's health check; without one, a running box is all there is to go on.
export function deriveWorkloadState(box: Fetched<RawBox | null>, probe?: ProbeResult): Derived {
  if (!box.ok) return { state: "UNKNOWN", reasons: [`box: ${box.error}`] };
  if (box.value?.state !== "running") return { state: "BOX_STOPPED", reasons: [`box is ${box.value?.state ?? "missing"}`] };
  if (!probe) return { state: "UP", reasons: ["box running · no health check (docker compose containers aren't visible to AWS)"] };
  if (probe.pass) return { state: "UP", reasons: [`probe ${probe.status ?? 200} in ${probe.ms ?? "?"}ms`] };
  const why = `probe failing: ${probe.error ?? `HTTP ${probe.status}`}`;
  return { state: probe.consecutiveFailures >= LIMITS.probeFailuresToFail ? "DOWN" : "DEGRADED", reasons: [why] };
}

export const emptySummary = (): Record<State, number> => ({
  UP: 0,
  DEGRADED: 0,
  DOWN: 0,
  DEPLOYING: 0,
  STOPPED: 0,
  BOX_STOPPED: 0,
  UNKNOWN: 0,
});

// Worst-first ordering, for sorting and for the env's headline state.
export const STATE_RANK: Record<State, number> = {
  DOWN: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  DEPLOYING: 3,
  BOX_STOPPED: 4,
  STOPPED: 5,
  UP: 6,
};

// Image tag → git sha when the tag carries one ("staging-<sha>", "<sha>", "v2-<sha>"). Moving tags and digests → no sha.
export function parseImage(image: string): { tag: string; sha?: string } {
  const at = image.indexOf("@");
  if (at >= 0) return { tag: image.slice(at + 1) };
  const colon = image.lastIndexOf(":");
  const slash = image.lastIndexOf("/");
  const tag = colon > slash ? image.slice(colon + 1) : "latest";
  const sha = shaFromTag(tag);
  return sha ? { tag, sha } : { tag };
}

export const touchesMigrations = (files: string[], paths: string[]) =>
  paths.length > 0 && files.some((f) => paths.some((p) => f.startsWith(p)));

// ---------- load balancer target groups (F01) ----------

export interface TgInput {
  arn: string;
  name?: string;
  healthy: number;
  unhealthy: number;
  initial?: number;
  draining?: number;
  desired?: number; // sum of the desired counts of the ECS services attached; undefined = unknown, treated as > 0
}

export interface TgHealth {
  state: "UP" | "DEGRADED" | "DOWN" | "STOPPED";
  active: number; // groups that are not idle
  bad: number; // active groups with an unhealthy target or no healthy one
  idle: { arn: string; name?: string }[];
  reason: string;
}

const tgName = (g: { arn: string; name?: string }) => g.name ?? g.arn.match(/targetgroup\/([^/]+)/)?.[1] ?? g.arn;

// A group with no targets at all whose services are scaled to 0 is idle (parked), not down. Every other group needs
// a healthy target and no unhealthy one; registering (initial) targets alone are not healthy yet.
export function targetGroupsHealth(groups: TgInput[]): TgHealth {
  const idle: { arn: string; name?: string }[] = [];
  let active = 0;
  let bad = 0;
  for (const g of groups) {
    const targets = g.healthy + g.unhealthy + (g.initial ?? 0) + (g.draining ?? 0);
    if (targets === 0 && g.desired === 0) {
      idle.push(g.name !== undefined ? { arn: g.arn, name: g.name } : { arn: g.arn });
      continue;
    }
    active++;
    if (g.unhealthy > 0 || g.healthy === 0) bad++;
  }
  const state = active === 0 ? "STOPPED" : bad === 0 ? "UP" : bad === active ? "DOWN" : "DEGRADED";
  const idleNote = idle.length ? `${idle.map(tgName).join(", ")} idle (service scaled to 0)` : "";
  const reason =
    active === 0
      ? idleNote || "no target groups"
      : `${active - bad}/${active} active target group${active === 1 ? "" : "s"} healthy${idleNote ? ` · ${idleNote}` : ""}`;
  return { state, active, bad, idle, reason };
}

export function tgHealthToResource(r: TgHealth): { health: "ok" | "warning" | "error"; reason: string } {
  const health = r.state === "DOWN" ? "error" : r.state === "DEGRADED" ? "warning" : "ok";
  return { health, reason: r.reason };
}

// ---------- capacity (R11) ----------

// running < desired with no rollout: a bounded start-up grace ("starting"), then a shortfall ("short") that degrades
// the service even while the remaining tasks are healthy, because redundancy or scale is lost.
export function capacityState(
  svc: { desired: number; running: number; pending: number; rollout: boolean },
  shortfallSince: number | undefined,
  now: number,
  graceMs: number,
): { state: "ok" | "starting" | "short"; reason?: string } {
  if (svc.desired <= 0 || svc.running >= svc.desired) return { state: "ok" };
  const counts = `${svc.running}/${svc.desired} running`;
  if (svc.rollout) return { state: "starting", reason: `starting (${counts}, rollout in progress)` };
  const since = shortfallSince ?? now;
  const age = Math.max(0, now - since);
  if (age < graceMs) return { state: "starting", reason: `starting (${counts})` };
  const mins = Math.floor(age / 60_000);
  return { state: "short", reason: `${counts}${svc.pending > 0 ? ` · ${svc.pending} pending` : ""} for ${mins} min` };
}
