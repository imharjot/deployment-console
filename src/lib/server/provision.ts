// Create & scale: copy a service, scale it, run a one-off task, add an EC2 host like an existing one, and remove what
// the console created. Each operation has a dry run (plan) and a run, used by the API routes and the agent operations
// alike, so both get the same checks.
//
// Order of every run: parse strictly → resolve names through discovery → role → pure guards (src/lib/provision.ts) →
// plan → typed confirmation → the mutation coordinator (mutate(), REVIEW R04) on canonical keys — the ECS service, or
// the cluster's hosts plus each EC2 instance — and under those keys: read everything again from AWS and re-run every
// guard, record the audit intent, only then call AWS → audit result → cache invalidation. Nothing reaches AWS before
// everything has been validated on live state. Audit params hold names, ids and counts only. RunTask and RunInstances
// carry a client token derived from the operation id, so an SDK retry of the same request never starts a second one.
//
// Hosts (R23): a launch is reserved in host_reservations before RunInstances is called, and the cap counts registered
// console-created hosts, instances tagged for the cluster that haven't joined it yet, and reservations still in flight.
// The sampler calls reconcileHostReservations() every tick: joined → registered; 15 minutes without → failed, audited,
// and an issue (console.ts hostIssues).
import "server-only";
import { isConsoleRule } from "../connect.ts";
import { ratesFrom } from "../costs.ts";
import { canonicalKey } from "../mutation-keys.ts";
import {
  CREATED_FROM_TAG, DEFAULT_SIZE, JOIN_TIMEOUT_MS, addHostCheck, addHostPlan, capabilityGate, capabilityWarning, capacityProblem, checkConfirm, cloneCheck, clonePlan,
  commandProblem, countHosts, createCheck, createPlan, createdTags, deleteGroupCheck, deleteGroupPlan, deleteServiceCheck, deleteServicePlan, fargateSizeProblem,
  groupNameFor, hostCountDetail, imageProblem, instanceTypeProblem, isConsoleCreated, limitsOf, newNameProblem, parseAddHost, parseClone, parseCreate, parseDeleteGroup,
  parseDeleteService, parseRunTask, parseScale, parseTerminateHost, pickDonor, pickNetwork, portProblem, provisionIam, reservationVerdict, runTaskCheck, runTaskPlan,
  scaleCheck, scalePlan, terminateHostCheck, terminateHostPlan,
  type Autoscaling, type CapabilityGate, type Check, type Confirmable, type CreateDonor, type HostCount, type HostReservation, type ProvisionAction, type ProvisionInfo,
  type ProvisionLimits, type ProvisionPlan, type ReservationVerdict, type ServiceFacts,
} from "../provision.ts";
import { can, roleFor, type Perm, type User } from "../rbac.ts";
import type { EnvInfo, RawBox, RawSecurityGroup, RawService, RawTaggedHost } from "../types.ts";
import { writeAudit } from "./audit.ts";
import { cached, invalidate } from "./cache.ts";
import { capability } from "./capability.ts";
import { liveService } from "./console.ts";
import { getDb, newId } from "./db.ts";
import { catalog, consoleConfig, envInfo, inRegion, listEnvs, metaOf, servicesOf } from "./discovery.ts";
import { HttpError, errText, isOutcomeUnknown } from "./errors.ts";
import { mutate, type MutationActor, type MutationHandle } from "./mutations.ts";
import { markVerified } from "./operations.ts";
import { tagWarning } from "./providers/ecs-image.ts";
import { cloudFor } from "./sources.ts";

export interface Who {
  user: User; // role checks
  actor: string; // what the audit log records (an agent token names itself here)
  ip?: string;
  via?: string; // session | alb | dev | token | agent (operations)
  tokenId?: string;
  approval?: string; // a person approved an agent's request: they are the actor, the token is kept for the record
}

// What a dry run shows and what a run executes. A run calls prepare twice: once to confirm and pick the canonical keys,
// once more under those keys, so every guard sees the state AWS reports while the resource is held.
interface Prepared<R> {
  env: EnvInfo;
  plan: ProvisionPlan;
  input: Confirmable;
  action: string; // audit / operation action ("provision.clone", …)
  target: string;
  keys: string[]; // canonical keys (src/lib/mutation-keys.ts)
  retrySafe?: boolean; // F31: repeating it can't duplicate the effect
  after: () => void; // cache invalidation once the change was submitted or refused
  execute: (h: MutationHandle) => Promise<Omit<R, "operationId">>; // h.intent() first, then AWS
}

// ---------- helpers ----------

const limits = (): ProvisionLimits => limitsOf(consoleConfig().config.provisioning);
const rates = (region: string) => ratesFrom(consoleConfig().config.pricing, region);
const num = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
const GONE = ["shutting-down", "terminated"];
// Tags a copy keeps from its source: how the console links it to code. Never console:self, names or health checks
// (the copy isn't reachable at the source's URL).
const COPIED_TAGS = ["console:repo", "console:role", "console:migrations", "console:main"];

function need(who: Who, perm: Perm, env: EnvInfo) {
  // A compose env has no ECS cluster: anything sent with its cluster "" would land in ECS's "default" cluster.
  if (env.kind === "compose") throw new HttpError(409, `${env.id} runs on docker compose — create & scale works on ECS environments only`);
  if (!can(who.user, perm, env.protected)) throw new HttpError(403, `your role (${who.user.role}) can't do this in ${env.id} — needs ${roleFor(perm, env.protected)}`);
}
function orThrow(c: Check) {
  if (!c.ok) throw new HttpError(c.status, c.error);
}
function parsed<T>(p: { ok: true; value: T } | { ok: false; status: 400; error: string }): T {
  if (!p.ok) throw new HttpError(p.status, p.error);
  return p.value;
}
function problem(msg: string | undefined, status = 400) {
  if (msg) throw new HttpError(status, msg);
}
const log = (msg: string, data: Record<string, unknown>) => console.error(JSON.stringify({ level: 40, msg, ...data }));

// Cache keys as in console.ts: "<cluster>" in the home region, "<cluster>@<region>" elsewhere.
const at = (env: EnvInfo) => inRegion(env.cluster, env.region);

// Canonical keys: the same strings console actions, variable saves and map actions lock for the same resources.
const serviceKey = (env: EnvInfo, service: string) => canonicalKey({ ecsService: { region: env.region, cluster: env.cluster, service } });
const hostsKey = (env: EnvInfo) => canonicalKey({ ecsHosts: { region: env.region, cluster: env.cluster } });
const instanceKey = (env: EnvInfo, id: string) => canonicalKey({ ec2: { region: env.region, id } });
// A copy registers a task-definition family named like the new service; families are per region, not per cluster.
const familyKey = (env: EnvInfo, family: string) => canonicalKey({ console: `task-family:${env.region}/${family}` });
const envRef = (env: EnvInfo) => ({ id: env.id, label: env.label, protected: env.protected, region: env.region });

const actorOf = (who: Who): MutationActor => ({
  display: who.actor,
  kind: who.via === "agent" ? "agent" : who.via === "token" ? "token" : "person",
  userId: who.user.id,
  ...(who.ip ? { ip: who.ip } : {}),
  ...(who.via ? { via: who.via } : {}),
  ...(who.tokenId ? { tokenId: who.tokenId } : {}),
  ...(who.approval ? { approvalId: who.approval } : {}),
});

// RunTask / RunInstances idempotency token (ECS and EC2 take up to 64 ASCII characters): one per operation.
const clientToken = (operationId: string) => `dc-${operationId}`.slice(0, 64);

// Container instances of the cluster (only those that joined it).
async function readHosts(env: EnvInfo, fresh = false): Promise<RawBox[]> {
  if (fresh) invalidate(`hosts:${at(env)}`);
  const cloud = await cloudFor(env);
  return (await cached(`hosts:${at(env)}`, 5_000, () => cloud.hosts(env.cluster))).value;
}
const hostsOf = (env: EnvInfo, fresh = false): Promise<RawBox[]> => (env.kind !== "ec2" && env.kind !== "mixed" ? Promise.resolve([]) : readHosts(env, fresh));
const runningHosts = (hosts: RawBox[], except?: string) => hosts.filter((h) => h.state === "running" && h.id !== except).length;

// EC2 instances the console launched for the cluster, joined or not (R23).
async function taggedOf(env: EnvInfo, fresh = false): Promise<RawTaggedHost[]> {
  const cloud = await cloudFor(env);
  if (fresh) invalidate(`tagged:${at(env)}`);
  return (await cached(`tagged:${at(env)}`, 10_000, () => cloud.taggedHosts(env.cluster))).value;
}

const facts = (s: RawService, isSelf: boolean): ServiceFacts => ({
  desired: s.desired,
  inProgress: s.deployments.some((d) => d.rolloutState === "IN_PROGRESS"),
  isSelf,
  created: isConsoleCreated(s.tags),
  hasTaskDef: !!s.taskDef,
});

async function freshService(env: EnvInfo, service: string) {
  invalidate(`svc:${at(env)}`);
  const live = await liveService(env, service);
  return { live, meta: await metaOf(env, live) };
}

// The service's Application Auto Scaling target (CC-20): null when it has none, undefined when that can't be read.
async function autoscalingOf(env: EnvInfo, live: RawService): Promise<Autoscaling | null | undefined> {
  if (live.scalable) return live.scalable;
  try {
    const cloud = await cloudFor(env);
    const list = (await cached(`scalable:${at(env)}`, 60_000, () => cloud.scalableTargets(env.cluster))).value;
    const t = list.find((x) => x.service === live.name);
    return t ? { min: t.min, max: t.max, policies: t.policies } : null;
  } catch {
    return undefined;
  }
}

// F06: what the console's AWS identity may do, per action (capability.ts), as a button state and a plan warning.
function gateOf(action: ProvisionAction): CapabilityGate {
  const iam = provisionIam(action);
  return capabilityGate(capability(iam), iam);
}
function withCapability(plan: ProvisionPlan): ProvisionPlan {
  const w = capabilityWarning(gateOf(plan.action));
  return w ? { ...plan, warnings: [...plan.warnings, w] } : plan;
}

// After a change: the next overview reads AWS again. Creating or removing something also rebuilds discovery, so the
// map and the catalog pick it up without waiting for the 60 s rescan.
function refresh(env: EnvInfo, service?: string, inventory = false) {
  invalidate(`svc:${at(env)}`);
  invalidate(`hosts:${at(env)}`);
  invalidate(`tagged:${at(env)}`);
  if (service) invalidate(`events:${at(env)}:${service}`);
  if (inventory) invalidate("discovery:inventory");
}

async function dryRun<R>(p: Promise<Prepared<R>>): Promise<ProvisionPlan> {
  return withCapability((await p).plan);
}

// A run: confirm on the plan, then mutate() on the plan's keys. Inside, everything is read and checked again before
// the audit intent (a refusal there records nothing); the keys must not have moved in between.
async function run<R>(prepare: (body: unknown, who: Who) => Promise<Prepared<R>>, body: unknown, who: Who): Promise<R> {
  const first = await prepare(body, who);
  orThrow(checkConfirm(first.plan.confirm, first.input));
  try {
    const { operationId, result } = await mutate(
      {
        action: first.action, actor: actorOf(who), env: envRef(first.env), target: first.target, keys: first.keys, reason: first.input.reason, params: {},
        retrySafe: first.retrySafe,
      },
      async (h) => {
        const now = await prepare(body, who);
        if (now.keys.join("\n") !== first.keys.join("\n")) throw new HttpError(409, `${first.target} changed while this was being submitted — review the plan again`);
        orThrow(checkConfirm(now.plan.confirm, now.input));
        return now.execute(h);
      },
    );
    return { ...result, operationId } as R;
  } finally {
    first.after();
  }
}

// ---------- copy a service ----------

export interface CloneResult {
  ok: true;
  requestId: string;
  operationId: string;
  env: string;
  service: string;
  taskDefinition?: string;
}

async function prepareClone(body: unknown, who: Who): Promise<Prepared<CloneResult>> {
  const i = parsed(parseClone(body));
  const lim = limits();
  const env = await envInfo(i.env);
  need(who, "provision", env);
  const srcEnv = await envInfo(i.sourceEnv); // any discovered env of the same region
  if (srcEnv.region !== env.region) throw new HttpError(400, `a service can only be copied within one region: ${srcEnv.id} is in ${srcEnv.region}, ${env.id} in ${env.region}`);
  invalidate(`svc:${at(env)}`);
  const [src, here] = await Promise.all([liveService(srcEnv, i.source), servicesOf(env.cluster, env.region)]);
  const meta = await metaOf(srcEnv, src);
  const cloud = await cloudFor(env);
  const spec = await cloud.serviceSpec(srcEnv.cluster, src.name);
  orThrow(cloneCheck({ isSelf: meta.self, hasTaskDef: !!src.taskDef, sourceProtected: srcEnv.protected, targetProtected: env.protected, launchType: spec.launchType ?? src.launchType }, lim));
  const td = src.taskDef!;

  problem(newNameProblem(i.name, []));
  if (here.some((s) => s.name === i.name)) throw new HttpError(409, `a service named "${i.name}" already exists in ${env.id}`);
  if (i.image) problem(imageProblem(i.image, limits().allowedImageRegistries));
  if (i.desired < 0 || i.desired > lim.maxTasks) throw new HttpError(400, `desired count must be 0–${lim.maxTasks}`);
  if (i.cpu !== undefined || i.memory !== undefined) {
    if (src.launchType !== "FARGATE") throw new HttpError(400, "CPU and memory can only be changed for Fargate services (EC2 tasks keep the source's container limits)");
    problem(fargateSizeProblem(i.cpu ?? num(td.cpu) ?? 0, i.memory ?? num(td.memory) ?? 0));
  }
  // The new service's family is its name. Adding a revision to someone else's family could change what their service
  // (or a deploy pipeline that registers "latest") runs, so only a family the console created itself may be reused.
  const family = await cloud.familyInfo(i.name);
  if (family && !family.consoleCreated) throw new HttpError(409, `a task-definition family named "${i.name}" already exists and wasn't created by the console — pick another name`);

  const sameEnv = srcEnv.id === env.id;
  if (!sameEnv) {
    const target = (await cached(`provision:${inRegion("clusters", env.region)}`, 30_000, () => cloud.clusters())).value.find((c) => c.name === env.cluster);
    problem(capacityProblem({ launchType: spec.launchType, capacityProviders: spec.capacityProviderStrategy.map((c) => c.provider) }, { env: env.id, capacityProviders: target?.capacityProviders ?? [], containerInstances: target?.containerInstances ?? 0 }), 409);
  }
  const donors = sameEnv ? [] : await Promise.all(here.map(async (s) => ({ service: s.name, subnets: s.subnets, launchType: s.launchType, isSelf: (await metaOf(env, s)).self })));
  const network = pickNetwork({ service: src.name, networkMode: td.networkMode, launchType: src.launchType, sameEnv }, env.id, donors);
  if (!network.ok) throw new HttpError(409, network.error);
  const net = network.mode === "host" ? undefined : network.sameAsSource ? spec.network : (await cloud.serviceSpec(env.cluster, network.from)).network;
  if (network.mode === "awsvpc" && !net) throw new HttpError(409, `couldn't read the subnets and security groups of ${network.from}`);
  const hosts = network.mode === "host" ? await hostsOf(env) : undefined;

  const plan = clonePlan({
    env,
    source: {
      env: srcEnv.id, service: src.name, family: td.family, revision: td.revision, image: td.image, launchType: src.launchType, networkMode: td.networkMode,
      cpu: num(td.cpu), memory: num(td.memory), arm: td.arch === "arm64", execEnabled: spec.enableExecuteCommand, loadBalancers: spec.loadBalancers,
      registries: spec.serviceRegistries, serviceConnect: spec.serviceConnect,
    },
    name: i.name, desired: i.desired, image: i.image, cpu: i.cpu, memory: i.memory, network, familyExists: !!family,
    runningHosts: hosts ? runningHosts(hosts) : undefined, rates: rates(env.region),
  });
  const tags = createdTags(`${srcEnv.id}/${src.name}`, Object.fromEntries(Object.entries(src.tags).filter(([k]) => COPIED_TAGS.includes(k))));

  return {
    env, plan, input: i, action: "provision.clone", target: i.name,
    keys: [serviceKey(env, i.name), familyKey(env, i.name)],
    after: () => refresh(env, i.name, true),
    execute: async (h) => {
      await h.intent({ source: `${srcEnv.id}/${src.name}`, from: td.arn, desired: i.desired, image: i.image, cpu: i.cpu, memory: i.memory, network: network.mode === "host" ? "host" : network.from });
      const arn = await cloud.registerCopy(td.arn, {
        family: i.name, image: i.image ? { container: td.main, image: i.image } : undefined, cpu: i.cpu ? String(i.cpu) : undefined,
        memory: i.memory ? String(i.memory) : undefined, streamPrefix: i.name, tags,
      });
      let requestId: string;
      try {
        requestId = await cloud.createService({
          cluster: env.cluster, name: i.name, taskDefinition: arn, desired: i.desired, launchType: spec.launchType, capacityProviderStrategy: spec.capacityProviderStrategy,
          network: net, platformVersion: spec.platformVersion, placementConstraints: spec.placementConstraints, placementStrategy: spec.placementStrategy,
          enableExecuteCommand: spec.enableExecuteCommand, tags,
        });
      } catch (e) {
        if (isOutcomeUnknown(e)) throw e; // the service may exist: the coordinator records "outcome unknown"
        throw new Error(`${errText(e)} — task definition ${arn.split("/").pop()} was registered, no service was created`);
      }
      if (requestId) h.requestId(requestId);
      return { ok: true, requestId, env: env.id, service: i.name, taskDefinition: arn };
    },
  };
}

export const planClone = (body: unknown, who: Who) => dryRun(prepareClone(body, who));
export const runClone = (body: unknown, who: Who) => run(prepareClone, body, who);

// ---------- a new service from an image ----------

export interface CreateResult extends CloneResult {
  securityGroup: string;
}

// The main container's log group, where a new service's logs go too (the console creates no log groups).
const logGroupOf = (s: RawService) => s.taskDef?.containers.find((c) => c.name === s.taskDef?.main)?.logGroup ?? s.taskDef?.logGroup;
// A service being deleted (DRAINING) neither lends its network nor keeps a security group in use.
const staying = (list: RawService[]) => list.filter((s) => s.status !== "DRAINING");
const donorsOf = (env: EnvInfo, list: RawService[]): Promise<CreateDonor[]> =>
  Promise.all(staying(list).map(async (s) => ({
    service: s.name, subnets: s.subnets, launchType: s.launchType, executionRole: s.taskDef?.executionRoleArn, logGroup: logGroupOf(s), isSelf: (await metaOf(env, s)).self,
  })));
// A security group is "made for" <cluster>/<service> (its console:created-from tag): it goes with that service.
const madeFor = (env: EnvInfo, service: string) => `${env.cluster}/${service}`;

async function prepareCreate(body: unknown, who: Who): Promise<Prepared<CreateResult>> {
  const i = parsed(parseCreate(body));
  const lim = limits();
  const env = await envInfo(i.env);
  need(who, "provision", env);
  orThrow(createCheck(lim));
  problem(newNameProblem(i.name, []));
  problem(imageProblem(i.image, lim.allowedImageRegistries));
  if (i.port !== undefined) problem(portProblem(i.port));
  const cpu = i.cpu ?? DEFAULT_SIZE.cpu;
  const memory = i.memory ?? DEFAULT_SIZE.memory;
  problem(fargateSizeProblem(cpu, memory));
  if (i.desired < 0 || i.desired > lim.maxTasks) throw new HttpError(400, `desired count must be 0–${lim.maxTasks}`);
  invalidate(`svc:${at(env)}`);
  const here = await servicesOf(env.cluster, env.region);
  if (here.some((s) => s.name === i.name)) throw new HttpError(409, `a service named "${i.name}" already exists in ${env.id}`);
  const cloud = await cloudFor(env);
  // As for a copy: a revision in someone else's family could change what their service or pipeline runs.
  const family = await cloud.familyInfo(i.name);
  if (family && !family.consoleCreated) throw new HttpError(409, `a task-definition family named "${i.name}" already exists and wasn't created by the console — pick another name`);
  const choice = pickDonor(env.id, await donorsOf(env, here));
  if (!choice.ok) throw new HttpError(409, choice.error);
  const donor = here.find((s) => s.name === choice.donor)!;
  const net = (await cloud.serviceSpec(env.cluster, donor.name)).network;
  if (!net?.subnets.length) throw new HttpError(409, `couldn't read the subnets of ${donor.name}`);
  const vpcId = (await cached(`subnet-vpcs:${inRegion(net.subnets.join(","), env.region)}`, 60_000, () => cloud.subnetVpcs(net.subnets))).value[net.subnets[0]];
  if (!vpcId) throw new HttpError(409, `couldn't find the VPC of ${donor.name}'s subnets`);
  const executionRole = donor.taskDef!.executionRoleArn!;
  const logGroup = logGroupOf(donor)!;
  const group = groupNameFor(env.cluster, i.name);
  const plan = createPlan({
    env, name: i.name, image: i.image, port: i.port, cpu, memory, desired: i.desired, group, familyExists: !!family, rates: rates(env.region),
    donor: { service: donor.name, why: choice.why, subnets: net.subnets, assignPublicIp: net.assignPublicIp, vpcId, executionRole, logGroup },
  });
  const missing = await tagWarning(i.image, env.region);
  if (missing) plan.warnings.push(missing);
  const tags = createdTags(i.image);

  return {
    env, plan, input: i, action: "provision.create", target: i.name,
    keys: [serviceKey(env, i.name), familyKey(env, i.name)],
    after: () => refresh(env, i.name, true),
    execute: async (h) => {
      await h.intent({ image: i.image, port: i.port, cpu, memory, desired: i.desired, donor: donor.name, vpc: vpcId, securityGroup: group });
      const groupId = await cloud.createSecurityGroup({
        vpcId, name: group, description: `Tasks of ECS service ${madeFor(env, i.name)}, created by deployment-console`.slice(0, 255),
        tags: { ...createdTags(madeFor(env, i.name)), Name: group },
      });
      let arn: string | undefined;
      try {
        arn = await cloud.registerTaskDefinition({
          family: i.name, image: i.image, port: i.port, cpu: String(cpu), memory: String(memory), executionRole, logs: { group: logGroup, prefix: i.name }, tags,
        });
        const requestId = await cloud.createService({
          cluster: env.cluster, name: i.name, taskDefinition: arn, desired: i.desired, launchType: "FARGATE", capacityProviderStrategy: [],
          network: { subnets: net.subnets, securityGroups: [groupId], assignPublicIp: net.assignPublicIp }, placementConstraints: [], placementStrategy: [],
          enableExecuteCommand: false, tags,
        });
        if (requestId) h.requestId(requestId);
        return { ok: true, requestId, env: env.id, service: i.name, taskDefinition: arn, securityGroup: groupId };
      } catch (e) {
        if (isOutcomeUnknown(e)) throw e; // the service may exist: the coordinator records "outcome unknown"
        // Refused: nothing runs in the new group yet, so it goes again. A registered task definition stays, like a copy's.
        let left = "";
        await cloud.deleteSecurityGroup(groupId).catch((x) => {
          left = `, security group ${groupId} was left (delete it from New → Created by the console)`;
          log("security group not removed after a refused create", { group: groupId, err: errText(x) });
        });
        throw new Error(`${errText(e)} — ${arn ? `task definition ${arn.split("/").pop()} was registered, ` : ""}no service was created${left}`);
      }
    },
  };
}

export const planCreate = (body: unknown, who: Who) => dryRun(prepareCreate(body, who));
export const runCreate = (body: unknown, who: Who) => run(prepareCreate, body, who);

// ECR repositories of the environment's region and a repository's newest tags, for the new-service form.
export async function imageChoices(envId: string, repository?: string): Promise<{ repositories?: { name: string; uri: string }[]; tags?: { tag: string; pushedAt?: number }[] }> {
  const env = await envInfo(envId);
  const cloud = await cloudFor(env);
  const repos = (await cached(`ecr-repos:${inRegion("all", env.region)}`, 60_000, () => cloud.repositories())).value;
  if (repository === undefined) return { repositories: repos };
  if (!repos.some((r) => r.name === repository)) throw new HttpError(404, `no ECR repository "${repository.slice(0, 80)}" in ${env.region}`);
  return { tags: (await cached(`ecr-recent:${inRegion(repository, env.region)}`, 30_000, () => cloud.recentImages(repository))).value };
}

// ---------- scale ----------

export interface ScaleResult {
  ok: true;
  requestId: string;
  operationId: string;
  env: string;
  service: string;
  desired: number;
}

async function prepareScale(body: unknown, who: Who): Promise<Prepared<ScaleResult>> {
  const i = parsed(parseScale(body));
  const env = await envInfo(i.env);
  need(who, "provision", env);
  const { live, meta } = await freshService(env, i.service);
  orThrow(scaleCheck(facts(live, meta.self), limits(), i.desired));
  const td = live.taskDef;
  const [hosts, autoscaling] = await Promise.all([live.launchType === "EC2" ? hostsOf(env) : undefined, autoscalingOf(env, live)]);
  const plan = scalePlan({
    env, service: live.name, from: live.desired, to: i.desired, launchType: live.launchType, networkMode: td?.networkMode,
    cpu: num(td?.cpu), memory: num(td?.memory), arm: td?.arch === "arm64", runningHosts: hosts ? runningHosts(hosts) : undefined, autoscaling, rates: rates(env.region),
  });
  return {
    env, plan, input: i, action: "provision.scale", target: live.name,
    keys: [serviceKey(env, live.name)],
    retrySafe: true, // setting a desired count twice sets it once
    after: () => refresh(env, live.name),
    execute: async (h) => {
      const cloud = await cloudFor(env);
      await h.intent({ desiredBefore: live.desired, desiredAfter: i.desired, ...(autoscaling ? { autoscalingMin: autoscaling.min, autoscalingMax: autoscaling.max } : {}) });
      const requestId = await cloud.updateService(env.cluster, live.name, { desired: i.desired });
      if (requestId) h.requestId(requestId);
      return { ok: true, requestId, env: env.id, service: live.name, desired: i.desired };
    },
  };
}

export const planScale = (body: unknown, who: Who) => dryRun(prepareScale(body, who));
export const runScale = (body: unknown, who: Who) => run(prepareScale, body, who);

// ---------- one-off task ----------

export interface RunTaskResult {
  ok: true;
  requestId: string;
  operationId: string;
  env: string;
  service: string;
  taskArn: string;
  taskId: string;
  logs?: { group: string; stream?: string }; // where its output lands (awslogs)
}

async function prepareRunTask(body: unknown, who: Who): Promise<Prepared<RunTaskResult>> {
  const i = parsed(parseRunTask(body));
  const env = await envInfo(i.env);
  need(who, "act", env);
  const { live, meta } = await freshService(env, i.service);
  orThrow(runTaskCheck(facts(live, meta.self), limits()));
  const td = live.taskDef!;
  const container = i.container ?? td.main;
  const c = td.containers.find((x) => x.name === container);
  if (!c) throw new HttpError(400, `no container "${container}" in ${td.family}:${td.revision} (it has ${td.containers.map((x) => x.name).join(", ")})`);
  if (i.command) problem(commandProblem(i.command));
  const cloud = await cloudFor(env);
  const spec = await cloud.serviceSpec(env.cluster, live.name);
  const network = spec.network
    ? `same subnets and security groups as ${live.name}${spec.network.assignPublicIp ? " (with a public IP)" : ""}`
    : `${td.networkMode ?? "bridge"} networking on the cluster's EC2 hosts`;
  const plan = runTaskPlan({
    env, service: live.name, taskDefinition: `${td.family}:${td.revision}`, launchType: live.launchType, networkMode: td.networkMode, container, command: i.command,
    logs: c.logGroup ? { group: c.logGroup, prefix: c.logStreamPrefix } : undefined, network, cpu: num(td.cpu), memory: num(td.memory), arm: td.arch === "arm64", rates: rates(env.region),
  });
  return {
    env, plan, input: i, action: "provision.run-task", target: live.name,
    keys: [serviceKey(env, live.name)],
    after: () => refresh(env, live.name),
    execute: async (h) => {
      // The command is the forensic record of what ran (it's in ECS and CloudTrail anyway); capped in size.
      await h.intent({ taskDefinition: td.arn, container, commandOverride: !!i.command, command: i.command ? JSON.stringify(i.command).slice(0, 2000) : undefined });
      const res = await cloud.runTask({
        cluster: env.cluster, taskDefinition: td.arn, service: live.name, launchType: spec.launchType, capacityProviderStrategy: spec.capacityProviderStrategy,
        network: spec.network, platformVersion: spec.platformVersion, placementConstraints: spec.placementConstraints, placementStrategy: spec.placementStrategy,
        override: i.command ? { container, command: i.command } : undefined, tags: createdTags(`${env.id}/${live.name}`), clientToken: clientToken(h.operationId),
      });
      if (res.requestId) h.requestId(res.requestId);
      const taskId = res.taskArn.split("/").pop() ?? res.taskArn;
      const logs = c.logGroup ? { group: c.logGroup, stream: c.logStreamPrefix ? `${c.logStreamPrefix}/${container}/${taskId}` : undefined } : undefined;
      return { ok: true, requestId: res.requestId, env: env.id, service: live.name, taskArn: res.taskArn, taskId, logs };
    },
  };
}

export const planRunTask = (body: unknown, who: Who) => dryRun(prepareRunTask(body, who));
export const runRunTask = (body: unknown, who: Who) => run(prepareRunTask, body, who);

// ---------- add EC2 hosts ----------

export interface AddHostResult {
  ok: true;
  requestId: string;
  operationId: string;
  env: string;
  instanceIds: string[];
}

// "<source Name>-<n>" with the first free n, so a dry run and the run that follows name the hosts the same way.
function hostName(source: RawBox, hosts: RawBox[]) {
  const own = source.tags.Name ?? source.id;
  const base = (isConsoleCreated(source.tags) ? own.replace(/-\d+$/, "") : own).slice(0, 200);
  const taken = new Set(hosts.map((h) => h.tags.Name));
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ---------- host reservations (R23) ----------

interface ReservationRow {
  id: string;
  env: string;
  region: string | null;
  cluster: string;
  operation_id: string | null;
  count: number;
  instance_ids: string;
  state: string;
  created_at: number;
  expires_at: number;
  detail: string | null;
}

const idsOf = (json: string | null): string[] => {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const reservationOf = (r: ReservationRow): HostReservation => ({
  id: r.id, operationId: r.operation_id ?? undefined, count: Number(r.count), instanceIds: idsOf(r.instance_ids),
  state: r.state as HostReservation["state"], createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
});

async function pendingReservations(env: EnvInfo): Promise<ReservationRow[]> {
  return (await getDb()).all<ReservationRow>(
    "SELECT * FROM host_reservations WHERE env = ? AND cluster = ? AND (region = ? OR region IS NULL) AND state = 'pending' ORDER BY created_at",
    [env.id, env.cluster, env.region],
  );
}

// Every console-created host the cap counts: joined, joining, or being launched. Fails closed: a cap that can't be
// counted refuses the launch.
async function hostCountFor(env: EnvInfo, hosts: RawBox[], fresh: boolean): Promise<HostCount> {
  const [tagged, rows] = await Promise.all([
    taggedOf(env, fresh).catch((e) => {
      throw new HttpError(503, `couldn't read the EC2 instances launched for ${env.cluster}, so the host limit can't be checked: ${errText(e)}`, 30_000);
    }),
    pendingReservations(env).catch((e) => {
      throw new HttpError(503, `the console database is unavailable, so the host limit can't be checked: ${errText(e)}`, 30_000);
    }),
  ]);
  return countHosts({ registered: hosts, tagged, reservations: rows.map(reservationOf), now: Date.now() });
}

// Reserved before RunInstances is called, so a launch whose response is lost still counts.
async function reserveHosts(env: EnvInfo, operationId: string, count: number): Promise<string> {
  const id = newId();
  const now = Date.now();
  try {
    await (await getDb()).run(
      "INSERT INTO host_reservations (id, env, region, cluster, operation_id, count, instance_ids, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, '[]', 'pending', ?, ?)",
      [id, env.id, env.region, env.cluster, operationId, count, now, now + JOIN_TIMEOUT_MS],
    );
  } catch (e) {
    throw new HttpError(503, `couldn't reserve the hosts in the console database, nothing was launched: ${errText(e)}`, 30_000);
  }
  return id;
}

// Bookkeeping after AWS answered: never fails the request (the instances are counted through their tags anyway).
async function updateReservation(id: string, set: { instanceIds?: string[]; state?: "released" | "registered"; detail?: string }) {
  try {
    if (set.instanceIds) await (await getDb()).run("UPDATE host_reservations SET instance_ids = ? WHERE id = ?", [JSON.stringify(set.instanceIds), id]);
    if (set.state) await (await getDb()).run("UPDATE host_reservations SET state = ?, detail = ? WHERE id = ? AND state = 'pending'", [set.state, set.detail ?? null, id]);
  } catch (e) {
    log("host reservation not updated", { reservation: id, err: errText(e) });
  }
}

// A host the console terminates is a container instance of the cluster (terminate refuses anything else), so it did
// join: drop it from its launch's reservation, or the reconciler would report it as ended before joining once it
// leaves both lists. A reservation left with no ids is settled as registered.
async function forgetInstance(env: EnvInfo, instanceId: string) {
  try {
    for (const r of await pendingReservations(env)) {
      const ids = idsOf(r.instance_ids);
      if (!ids.includes(instanceId)) continue;
      const left = ids.filter((x) => x !== instanceId);
      if (left.length) await updateReservation(r.id, { instanceIds: left });
      else await updateReservation(r.id, { state: "registered" });
    }
  } catch (e) {
    log("host reservation not updated", { instance: instanceId, err: errText(e) });
  }
}

async function prepareAddHost(body: unknown, who: Who): Promise<Prepared<AddHostResult>> {
  const i = parsed(parseAddHost(body));
  const lim = limits();
  const env = await envInfo(i.env);
  need(who, "provision", env);
  const hosts = await hostsOf(env, true);
  const h = hosts.find((x) => x.id === i.from);
  if (!h) throw new HttpError(404, `${i.from} isn't an EC2 container instance of ${env.id}`);
  const counted = await hostCountFor(env, hosts, true);
  const detail = hostCountDetail(counted);
  orThrow(addHostCheck({ state: h.state, asg: h.asg, created: isConsoleCreated(h.tags) }, lim, counted.total, i.count, detail));
  const cloud = await cloudFor(env);
  const spec = await cloud.hostSpec(h.id);
  if (spec.asg) orThrow(addHostCheck({ state: h.state, asg: spec.asg, created: false }, lim, counted.total, i.count, detail));
  const type = i.instanceType ?? spec.instanceType;
  problem(instanceTypeProblem(type, lim.allowedInstanceTypes));
  const name = hostName(h, hosts);
  const plan = addHostPlan({
    env, cluster: env.cluster, count: i.count, instanceType: type, name, rates: rates(env.region),
    source: {
      id: h.id, name: h.tags.Name ?? h.id, instanceType: spec.instanceType, imageId: spec.imageId, subnetId: spec.subnetId, securityGroups: spec.securityGroups,
      instanceProfile: spec.instanceProfileArn?.split("/").pop(), keyName: spec.keyName, hasUserData: spec.hasUserData, launchTemplate: spec.launchTemplate, hasPublicIp: spec.hasPublicIp,
    },
  });
  if (detail) plan.warnings.push(`Counted against provisioning.maxHosts (${lim.maxHosts}): ${counted.total} console-created host${counted.total === 1 ? "" : "s"} — ${detail}.`);
  return {
    env, plan, input: i, action: "provision.add-host", target: h.id,
    // One launch at a time per cluster, so the cap holds; the source host too (its spec is what gets copied).
    keys: [hostsKey(env), instanceKey(env, h.id)],
    after: () => refresh(env, undefined, true),
    execute: async (hd) => {
      await hd.intent({ from: h.id, count: i.count, instanceType: type, launchTemplate: spec.launchTemplate?.id, hostsCounted: counted.total });
      const reservation = await reserveHosts(env, hd.operationId, i.count);
      let res: { instanceIds: string[]; requestId: string };
      try {
        res = await cloud.launchHosts(h.id, { count: i.count, instanceType: i.instanceType, tags: createdTags(h.id, { ...spec.tags, Name: name }), cluster: env.cluster, clientToken: clientToken(hd.operationId) });
      } catch (e) {
        // Refused: nothing started, the reservation goes. Unknown: it stays until the instances show or it expires.
        if (!isOutcomeUnknown(e)) await updateReservation(reservation, { state: "released", detail: `launch refused: ${errText(e)}`.slice(0, 500) });
        throw e;
      }
      if (res.requestId) hd.requestId(res.requestId);
      await updateReservation(reservation, { instanceIds: res.instanceIds });
      return { ok: true, requestId: res.requestId, env: env.id, instanceIds: res.instanceIds };
    },
  };
}

export const planAddHost = (body: unknown, who: Who) => dryRun(prepareAddHost(body, who));
export const runAddHost = (body: unknown, who: Who) => run(prepareAddHost, body, who);

// Each sampler tick (console.ts): what became of the hosts launched in the last 15 minutes. Joined → registered (the
// operation is verified); not joined within JOIN_TIMEOUT_MS → failed, with an audit row on the launch's operation and
// an issue "host i-… launched but never joined <cluster>" (console.ts hostIssues). Several consoles may run this at
// once: a row changes state once (conditional update) and only that console writes the audit row. Never throws.
export async function reconcileHostReservations(envs: EnvInfo[], o: { now?: number } = {}): Promise<void> {
  try {
    const db = await getDb();
    // One statement, so a reservation and its operation's state are read together: the launch records the instance ids
    // before its operation succeeds, so "succeeded without ids" can't be a launch whose ids were written in between.
    const rows = await db.all<ReservationRow & { op_state: string | null }>(
      "SELECT h.*, o.state AS op_state FROM host_reservations h LEFT JOIN operations o ON o.id = h.operation_id WHERE h.state = 'pending' ORDER BY h.created_at LIMIT 200",
    );
    if (!rows.length) return;
    const now = o.now ?? Date.now();
    const groups = new Map<string, (ReservationRow & { op_state: string | null })[]>();
    for (const r of rows) {
      const k = `${r.env}\n${r.region ?? ""}\n${r.cluster}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const list of groups.values()) {
      const r0 = list[0];
      const env = envs.find((e) => e.id === r0.env && e.cluster === r0.cluster && (!r0.region || e.region === r0.region)) ?? envs.find((e) => e.cluster === r0.cluster && (!r0.region || e.region === r0.region));
      let seen: { registered: Set<string>; tagged: Set<string> } | undefined;
      if (env) {
        try {
          // Straight from AWS (only while launches are pending): the views' 5–10 s caches may predate the join.
          const cloud = await cloudFor(env);
          const [registered, tagged] = await Promise.all([cloud.hosts(env.cluster), cloud.taggedHosts(env.cluster)]);
          seen = { registered: new Set(registered.map((h) => h.id)), tagged: new Set(tagged.filter((h) => !GONE.includes(h.state)).map((h) => h.id)) };
        } catch (e) {
          log("host reservations: hosts not read", { env: r0.env, cluster: r0.cluster, err: errText(e) });
          continue; // try again next tick
        }
      }
      for (const row of list) {
        const r = reservationOf(row);
        const v: ReservationVerdict = seen
          ? reservationVerdict(r, seen, now, row.cluster, row.op_state ?? undefined)
          : now >= r.expiresAt
            ? { state: "failed", instanceIds: r.instanceIds, detail: `hosts launched for ${row.cluster}, which the console no longer finds` }
            : { state: "pending" };
        await settleReservation(row, v, now).catch((e) => log("host reservation not settled", { reservation: row.id, err: errText(e) }));
      }
    }
  } catch (e) {
    log("host reservations not reconciled", { err: errText(e) });
  }
}

async function settleReservation(row: ReservationRow, v: ReservationVerdict, now: number) {
  if (v.state === "pending") return;
  const db = await getDb();
  const ids = v.state === "failed" ? v.instanceIds : idsOf(row.instance_ids);
  const detail = v.state === "registered" ? null : (v.detail ?? null);
  // Only the row as it was read: another console may have settled it, or the launch recorded its ids since.
  const changed = await db.run("UPDATE host_reservations SET state = ?, instance_ids = ?, detail = ? WHERE id = ? AND state = 'pending' AND instance_ids = ?", [
    v.state, JSON.stringify(ids), detail, row.id, row.instance_ids,
  ]);
  if (!changed) return;
  const op = row.operation_id ?? undefined;
  if (v.state === "registered") {
    if (op) await markVerified(op, true).catch((e) => log("operation not marked verified", { operationId: op, err: errText(e) }));
    return;
  }
  if (v.state !== "failed") return;
  const msg = v.detail ?? `host${ids.length === 1 ? "" : "s"} ${ids.join(", ")} launched but never joined ${row.cluster}`;
  if (op) await markVerified(op, false, msg).catch((e) => log("operation not marked failed", { operationId: op, err: errText(e) }));
  await writeAudit({
    at: now, phase: "result", env: row.env, target: row.cluster, action: "provision.add-host", user: "console (host check)", params: { instanceIds: ids, reservation: row.id },
    result: "error", detail: msg.slice(0, 500), operationId: op, region: row.region ?? undefined,
  }).catch((e) => log("audit write failed", { action: "provision.add-host", reservation: row.id, err: errText(e) }));
}

// ---------- remove what the console created ----------
// Allowed even with provisioning turned off, so a team can always clean up. Only resources tagged console:created=true
// (the shipped IAM policy enforces the same tag), never the console's own service.

export interface RemoveResult {
  ok: true;
  requestId: string;
  operationId: string;
  env: string;
  target: string;
  groupsLeft?: string[]; // a deleted service's security groups AWS kept (still in use by its stopping tasks)
}

const groupKey = (env: EnvInfo, id: string) => canonicalKey({ ec2: { region: env.region, id } });

// The security groups the console made for this service and nothing else of the cluster uses (a copy of a new service
// shares its group): they go with it.
async function ownGroups(env: EnvInfo, live: RawService, all: RawService[]): Promise<RawSecurityGroup[]> {
  if (!live.securityGroups.length) return [];
  const others = new Set(staying(all).filter((s) => s.name !== live.name).flatMap((s) => s.securityGroups));
  const groups = await (await cloudFor(env)).securityGroups(live.securityGroups);
  return groups.filter((g) => isConsoleCreated(g.tags) && g.tags?.[CREATED_FROM_TAG] === madeFor(env, live.name) && !others.has(g.id));
}

// The console's connection rules (Connect, providers/ecs-connect.ts) in the environment's other groups that admit
// one of `own`: AWS won't delete a group another group's rule names, and they connect nothing once it's gone.
async function connectionRules(env: EnvInfo, own: string[], svcs: RawService[]): Promise<{ group: string; port: number; from: string; text: string }[]> {
  if (!own.length) return [];
  const cat = await catalog(env.id).catch(() => undefined);
  const ids = [...new Set([...svcs.flatMap((s) => s.securityGroups), ...(cat?.databases ?? []).flatMap((d) => d.securityGroups), ...(cat?.caches ?? []).flatMap((c) => c.securityGroups)])].filter((g) => !own.includes(g));
  if (!ids.length) return [];
  const out: { group: string; port: number; from: string; text: string }[] = [];
  for (const g of await (await cloudFor(env)).securityGroups(ids))
    for (const r of g.inbound)
      for (const from of r.groups.filter((x) => own.includes(x)))
        if (r.fromPort !== undefined && r.fromPort >= 0 && isConsoleRule(r.notes?.[from] ?? (r.groups.length === 1 ? r.description : undefined)))
          out.push({ group: g.id, port: r.fromPort, from, text: `${g.id} allows ${from} on ${r.fromPort}` });
  return out;
}

async function prepareDeleteService(body: unknown, who: Who): Promise<Prepared<RemoveResult>> {
  const i = parsed(parseDeleteService(body));
  const env = await envInfo(i.env);
  need(who, "provision", env);
  const { live, meta } = await freshService(env, i.service);
  orThrow(deleteServiceCheck(facts(live, meta.self)));
  if (live.status === "DRAINING") throw new HttpError(409, `${live.name} is already being deleted`);
  const svcs = await servicesOf(env.cluster, env.region);
  const groups = (await ownGroups(env, live, svcs)).map((g) => g.id);
  const rules = await connectionRules(env, groups, svcs);
  const plan = deleteServicePlan({ env, service: live.name, desired: live.desired, family: live.taskDef?.family, groups, rules: rules.map((r) => r.text) });
  return {
    env, plan, input: i, action: "provision.delete-service", target: live.name,
    keys: [serviceKey(env, live.name), ...[...new Set([...groups, ...rules.map((r) => r.group)])].map((g) => groupKey(env, g))],
    after: () => refresh(env, live.name, true),
    execute: async (h) => {
      const cloud = await cloudFor(env);
      await h.intent({ desiredBefore: live.desired, taskDefinition: live.taskDef?.arn, ...(groups.length ? { securityGroups: groups } : {}), ...(rules.length ? { connectionRules: rules.map((r) => r.text) } : {}) });
      const requestId = await cloud.deleteService(env.cluster, live.name);
      if (requestId) h.requestId(requestId);
      for (const r of rules) {
        await cloud.revokeIngress(r.group, { port: r.port, fromGroup: r.from }).catch((e) => log("connection rule kept after its service was deleted", { rule: r.text, err: errText(e) }));
      }
      // Right away only when no task held a network interface in them; otherwise they wait for New → Created by the console.
      const groupsLeft: string[] = [];
      for (const g of groups) {
        await cloud.deleteSecurityGroup(g).catch((e) => {
          groupsLeft.push(g);
          log("security group kept after its service was deleted", { group: g, service: live.name, err: errText(e) });
        });
      }
      return { ok: true, requestId, env: env.id, target: live.name, ...(groupsLeft.length ? { groupsLeft } : {}) };
    },
  };
}

export const planDeleteService = (body: unknown, who: Who) => dryRun(prepareDeleteService(body, who));
export const runDeleteService = (body: unknown, who: Who) => run(prepareDeleteService, body, who);

// Security groups the console made for this env's services that no service of its cluster uses any more, in the VPCs
// its services run in. Cached briefly: the New menu reads it each time it opens.
async function leftoverGroups(env: EnvInfo, svcs: RawService[]): Promise<RawSecurityGroup[]> {
  const cloud = await cloudFor(env);
  const subnets = [...new Set(svcs.flatMap((s) => s.subnets))];
  if (!subnets.length) return [];
  const vpcs = [...new Set(Object.values((await cached(`subnet-vpcs:${inRegion(subnets.join(","), env.region)}`, 60_000, () => cloud.subnetVpcs(subnets))).value))];
  const used = new Set(staying(svcs).flatMap((s) => s.securityGroups));
  const made = (await cached(`created-groups:${inRegion(vpcs.join(","), env.region)}`, 10_000, () => cloud.createdGroups(vpcs))).value;
  return made.filter((g) => g.tags?.[CREATED_FROM_TAG]?.startsWith(`${env.cluster}/`) && !used.has(g.id));
}

async function prepareDeleteGroup(body: unknown, who: Who): Promise<Prepared<RemoveResult>> {
  const i = parsed(parseDeleteGroup(body));
  const env = await envInfo(i.env);
  need(who, "provision", env);
  invalidate(`svc:${at(env)}`);
  const svcs = await servicesOf(env.cluster, env.region);
  const cloud = await cloudFor(env);
  const notFound = (e: unknown) => ((e as { name?: string }).name === "InvalidGroup.NotFound" ? [] : Promise.reject(e));
  const g = (await cloud.securityGroups([i.id]).catch(notFound))[0];
  if (!g) throw new HttpError(404, `security group ${i.id} not found in ${env.region}`);
  if (!g.tags?.[CREATED_FROM_TAG]?.startsWith(`${env.cluster}/`)) throw new HttpError(404, `security group ${i.id} wasn't made for a service of ${env.id}`);
  orThrow(deleteGroupCheck({ created: isConsoleCreated(g.tags), usedBy: staying(svcs).filter((s) => s.securityGroups.includes(g.id)).map((s) => s.name) }));
  const plan = deleteGroupPlan({ env, id: g.id, name: g.name, vpcId: g.vpcId });
  return {
    env, plan, input: i, action: "provision.delete-security-group", target: g.id,
    keys: [groupKey(env, g.id)],
    retrySafe: true, // deleting a deleted group changes nothing
    after: () => {
      invalidate(`created-groups:`);
      refresh(env, undefined, true);
    },
    execute: async (h) => {
      await h.intent({ name: g.name, vpc: g.vpcId, madeFor: g.tags?.[CREATED_FROM_TAG] });
      const requestId = await cloud.deleteSecurityGroup(g.id);
      if (requestId) h.requestId(requestId);
      return { ok: true, requestId, env: env.id, target: g.id };
    },
  };
}

export const planDeleteGroup = (body: unknown, who: Who) => dryRun(prepareDeleteGroup(body, who));
export const runDeleteGroup = (body: unknown, who: Who) => run(prepareDeleteGroup, body, who);

async function prepareTerminateHost(body: unknown, who: Who): Promise<Prepared<RemoveResult>> {
  const i = parsed(parseTerminateHost(body));
  const env = await envInfo(i.env);
  need(who, "provision", env);
  const hosts = await hostsOf(env, true);
  const h = hosts.find((x) => x.id === i.id);
  if (!h) throw new HttpError(404, `${i.id} isn't an EC2 container instance of ${env.id}`);
  orThrow(terminateHostCheck({ state: h.state, asg: h.asg, created: isConsoleCreated(h.tags) }));
  const ec2Services = (await servicesOf(env.cluster, env.region)).filter((s) => s.launchType === "EC2" && s.desired > 0).length;
  const plan = terminateHostPlan({ env, id: h.id, name: h.tags.Name ?? h.id, instanceType: h.type, otherRunningHosts: runningHosts(hosts, h.id), ec2Services });
  return {
    env, plan, input: i, action: "provision.terminate-host", target: h.id,
    keys: [hostsKey(env), instanceKey(env, h.id)],
    retrySafe: true, // terminating a terminated instance changes nothing
    after: () => refresh(env, undefined, true),
    execute: async (hd) => {
      const cloud = await cloudFor(env);
      await hd.intent({ instanceType: h.type, state: h.state });
      const requestId = await cloud.terminateHost(h.id);
      if (requestId) hd.requestId(requestId);
      await forgetInstance(env, h.id);
      return { ok: true, requestId, env: env.id, target: h.id };
    },
  };
}

export const planTerminateHost = (body: unknown, who: Who) => dryRun(prepareTerminateHost(body, who));
export const runTerminateHost = (body: unknown, who: Who) => run(prepareTerminateHost, body, who);

// One table for the route: POST /api/provision/<action>.
export const PROVISION: Record<string, { plan: (body: unknown, who: Who) => Promise<ProvisionPlan>; run: (body: unknown, who: Who) => Promise<unknown> }> = {
  clone: { plan: planClone, run: runClone },
  create: { plan: planCreate, run: runCreate },
  scale: { plan: planScale, run: runScale },
  "run-task": { plan: planRunTask, run: runRunTask },
  "add-host": { plan: planAddHost, run: runAddHost },
  "delete-service": { plan: planDeleteService, run: runDeleteService },
  "delete-security-group": { plan: planDeleteGroup, run: runDeleteGroup },
  "terminate-host": { plan: planTerminateHost, run: runTerminateHost },
};

// ---------- what the UI needs to draw buttons and forms (no writes, no secrets) ----------

export async function provisionInfo(envId: string, user: User, withSources: boolean, withGroups = false): Promise<ProvisionInfo> {
  const env = await envInfo(envId);
  const [svcs, hosts] = await Promise.all([servicesOf(env.cluster, env.region), hostsOf(env)]);
  // What the cap counts (R23); when that can't be read, the joined hosts only — the run counts again and fails closed.
  const ec2 = env.kind === "ec2" || env.kind === "mixed";
  const hostCount = ec2
    ? await hostCountFor(env, hosts, false).catch(() => countHosts({ registered: hosts, tagged: [], reservations: [], now: Date.now() }))
    : countHosts({ registered: hosts, tagged: [], reservations: [], now: Date.now() });
  const actions: ProvisionAction[] = ["clone", "create", "scale", "run-task", "add-host", "delete-service", "delete-security-group", "terminate-host"];
  const services = await Promise.all(
    svcs.map(async (s) => {
      const m = await metaOf(env, s);
      return {
        name: s.name, display: m.name, status: s.status, desired: s.desired, launchType: s.launchType, created: isConsoleCreated(s.tags), self: m.self,
        inProgress: s.deployments.some((d) => d.rolloutState === "IN_PROGRESS"), hasTaskDef: !!s.taskDef, networkMode: s.taskDef?.networkMode,
        cpu: num(s.taskDef?.cpu), memory: num(s.taskDef?.memory), image: s.taskDef?.image, containers: s.taskDef?.containers.map((c) => c.name) ?? [], main: s.taskDef?.main,
        hidden: m.hidden,
      };
    }),
  );
  let sources: ProvisionInfo["sources"];
  if (withSources) {
    const envs = (await listEnvs()).filter((e) => e.region === env.region); // copies stay within one region
    const all = await Promise.all(
      envs.map(async (e) => {
        try {
          const list = await servicesOf(e.cluster, e.region);
          return Promise.all(list.map(async (s) => {
            const m = await metaOf(e, s);
            return { env: e.id, envLabel: e.label, protected: e.protected, name: s.name, display: m.name, launchType: s.launchType, networkMode: s.taskDef?.networkMode, cpu: num(s.taskDef?.cpu), memory: num(s.taskDef?.memory), image: s.taskDef?.image, self: m.self, hidden: m.hidden };
          }));
        } catch {
          return []; // an unreadable env just offers nothing to copy
        }
      }),
    );
    sources = all.flat().filter((s) => !s.hidden && !s.self).map((s) => ({ ...s, hidden: undefined }));
  }
  return {
    env: env.id,
    protected: env.protected,
    kind: env.kind,
    limits: limits(),
    can: { provision: can(user, "provision", env.protected), act: can(user, "act", env.protected), provisionRole: roleFor("provision", env.protected), actRole: roleFor("act", env.protected) },
    services: services.filter((s) => !s.hidden).map((s) => ({ ...s, hidden: undefined })),
    hosts: hosts.filter((h) => !GONE.includes(h.state)).map((h) => ({ id: h.id, name: h.tags.Name ?? h.id, type: h.type, state: h.state, asg: h.asg, created: isConsoleCreated(h.tags), launchTemplate: h.tags["aws:ec2launchtemplate:id"] })),
    hostCount,
    hostCountDetail: hostCountDetail(hostCount),
    capability: Object.fromEntries(actions.map((a) => [a, gateOf(a)])) as Record<ProvisionAction, CapabilityGate>,
    sources,
    donor: env.kind === "compose" ? { ok: false, error: `${env.id} runs on docker compose` } : pickDonor(env.id, await donorsOf(env, svcs)),
    // An unreadable list just offers nothing to clean up here; the delete itself reads again.
    ...(withGroups ? { groups: (await leftoverGroups(env, svcs).catch(() => [])).map((g) => ({ id: g.id, name: g.name, vpcId: g.vpcId, madeFor: g.tags?.[CREATED_FROM_TAG] ?? "" })) } : {}),
  };
}
