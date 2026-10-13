// AWS Batch, pure part: what the batch provider reads, real or simulated, → Resources, Links and Mentions (audit §6
// A.2, the P2 batch row; master plan C11).
//
// Reads (provider): DescribeComputeEnvironments, DescribeJobQueues, ListJobs (RUNNABLE and FAILED for health, RUNNING and
// SUCCEEDED for the last activity; one page each, for the first 50 queues) and DescribeJobDefinitions (ACTIVE). Compute
// environments and queues carry their tags.
// - Keys: the compute environment and job queue ARNs (arnOf.batchEnvironment / batchQueue). Queues also answer to their
//   name (job submitters name a queue by name or ARN).
// - Compute environment: its ECS cluster (AWSBatch-…) is a PROP, never a link — Batch's clusters aren't nodes (discovery
//   skips them). Links: → the instance role / instance profile, service role and Spot fleet role (assumes); → the EKS
//   cluster it runs on (uses). Network: subnets and security groups.
// - Queue: → each compute environment in its order (uses). Job definitions aren't nodes; what they say is drawn from the
//   queue that runs them: a definition a listed job of the queue used (confidence config) — or, never seen in a job, a
//   definition only one queue of the region can run (by platform: EC2, Fargate, EKS; confidence allowed). From those:
//   → the image's ECR repository (pulls); → the job and execution roles (assumes); → the secrets and parameters its
//   containers read (reads, the references only); → its awslogs group (logs). Container environment values become
//   Mention refs only (they may hold secrets); the log driver's other options are never read.
// - Health: compute environment ENABLED + VALID ok, INVALID error, DISABLED stopped, CREATING / UPDATING warning;
//   queue likewise, plus a job RUNNABLE for more than an hour: warning (it waits for capacity).
// - Activity: none from CloudWatch; lastActivityAt of a queue = now while a listed job is RUNNABLE or RUNNING (work is
//   in it), else its newest listed job — of every terminal status: a queue whose jobs all succeed is as used as one
//   whose jobs fail, so RUNNABLE and FAILED alone would date a busy queue by its last failure (a false idle).
// No AWS calls and no `server-only`, so node:test runs it (batch.test.ts).
import { arnOf, parseArn } from "./arn.ts";
import { ecrRepoRef, profileRef, roleRef } from "./compute-common.ts";
import { arnName, clip, enrichmentOf, envMentions, fmtTime, logGroupRef, plural, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, Mention, ProviderResult, Resource, ResourceDetail } from "./types.ts";

export const JOBS_QUEUES_MAX = 50; // ListJobs is read for the first 50 queues
export const JOBS_PAGE = 100; // one page of each status
export const RUNNABLE_WARN_MS = 60 * 60_000; // waiting longer than this for capacity: warning
const HOUR = 3_600_000;

// ---------- raw shapes (the fields the map reads; anything else the API returns is ignored) ----------

export interface RawComputeEnvironment {
  computeEnvironmentName?: string;
  computeEnvironmentArn?: string;
  ecsClusterArn?: string;
  tags?: Record<string, string>;
  type?: string; // MANAGED | UNMANAGED
  state?: string; // ENABLED | DISABLED
  status?: string; // CREATING | UPDATING | DELETING | DELETED | VALID | INVALID
  statusReason?: string;
  serviceRole?: string;
  containerOrchestrationType?: string; // ECS | EKS
  eksConfiguration?: { eksClusterArn?: string; kubernetesNamespace?: string };
  unmanagedvCpus?: number;
  computeResources?: {
    type?: string; // EC2 | SPOT | FARGATE | FARGATE_SPOT
    allocationStrategy?: string;
    minvCpus?: number;
    maxvCpus?: number;
    desiredvCpus?: number;
    instanceTypes?: string[];
    instanceRole?: string; // instance profile: name or ARN
    spotIamFleetRole?: string;
    subnets?: string[];
    securityGroupIds?: string[];
    bidPercentage?: number;
  };
}

export interface RawJob {
  jobArn?: string;
  jobId?: string;
  jobName?: string;
  createdAt?: number;
  startedAt?: number;
  stoppedAt?: number;
  status?: string;
  statusReason?: string;
  jobDefinition?: string; // the definition's ARN with its revision
}

// ListJobs, one page per status (`more`: that status had another page).
export interface QueueJobs {
  runnable?: RawJob[];
  failed?: RawJob[];
  running?: RawJob[];
  succeeded?: RawJob[];
  more?: { runnable?: boolean; failed?: boolean; running?: boolean; succeeded?: boolean };
}

export interface RawJobQueue {
  jobQueueName?: string;
  jobQueueArn?: string;
  state?: string;
  status?: string;
  statusReason?: string;
  priority?: number;
  schedulingPolicyArn?: string;
  computeEnvironmentOrder?: { order?: number; computeEnvironment?: string }[];
  tags?: Record<string, string>;
  jobs?: QueueJobs;
  enrichment?: Record<string, EnrichState>; // jobs
}

type KeyValue = { name?: string; value?: string };
type SecretRef = { name?: string; valueFrom?: string };
export interface BatchContainer {
  image?: string;
  jobRoleArn?: string;
  executionRoleArn?: string;
  environment?: KeyValue[];
  secrets?: SecretRef[];
  logConfiguration?: { logDriver?: string; options?: Record<string, string> };
}
export interface RawJobDefinition {
  jobDefinitionName?: string;
  jobDefinitionArn?: string;
  revision?: number;
  status?: string;
  type?: string; // container | multinode
  platformCapabilities?: string[]; // EC2 | FARGATE
  containerProperties?: BatchContainer;
  nodeProperties?: { nodeRangeProperties?: { targetNodes?: string; container?: BatchContainer }[] };
  ecsProperties?: { taskProperties?: { containers?: (BatchContainer & { name?: string })[]; taskRoleArn?: string; executionRoleArn?: string }[] };
  eksProperties?: { podProperties?: { serviceAccountName?: string; containers?: { name?: string; image?: string; env?: KeyValue[] }[] } };
}

export interface BatchInput {
  environments: RawComputeEnvironment[];
  queues: RawJobQueue[];
  definitions?: RawJobDefinition[]; // undefined: not read (denied, failed or past the time budget)
}

// ---------- helpers ----------

const STATUS_WORD = (s: string) => s.toLowerCase().replace(/_/g, " ");
const ago = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 48 * HOUR ? `${+(ms / HOUR).toFixed(1)} h` : `${Math.round(ms / (24 * HOUR))} days`);

// The compute platforms a compute environment offers: "EC2" (EC2 and Spot, and unmanaged), "FARGATE", or "EKS".
export function envPlatform(c: RawComputeEnvironment): "EC2" | "FARGATE" | "EKS" {
  if (c.containerOrchestrationType === "EKS" || c.eksConfiguration?.eksClusterArn) return "EKS";
  return /^FARGATE/.test(c.computeResources?.type ?? "") ? "FARGATE" : "EC2";
}
// The platform a job definition needs.
export function definitionPlatform(d: RawJobDefinition): "EC2" | "FARGATE" | "EKS" {
  if (d.eksProperties) return "EKS";
  return d.platformCapabilities?.includes("FARGATE") ? "FARGATE" : "EC2";
}

// "arn:aws:batch:r:a:job-definition/report:7" → "report:7".
export const definitionLabel = (arn: string | undefined) => (arn ? /job-definition\/(.+)$/.exec(arn)?.[1] ?? arn : undefined);

// Every container a definition runs, whatever its shape (single container, multi-node ranges, ECS task, EKS pod).
export function containersOf(d: RawJobDefinition): { image?: string; roles: string[]; env: KeyValue[]; secrets: SecretRef[]; logGroup?: string }[] {
  const out: { image?: string; roles: string[]; env: KeyValue[]; secrets: SecretRef[]; logGroup?: string }[] = [];
  const plain = (c: BatchContainer | undefined, roles: (string | undefined)[]) => {
    if (!c) return;
    const lc = c.logConfiguration;
    // Only the awslogs group is read: other drivers' options (splunk-token…) may be credentials.
    const logGroup = (lc?.logDriver ?? "awslogs") === "awslogs" ? lc?.options?.["awslogs-group"] ?? "/aws/batch/job" : undefined;
    out.push({ image: c.image, roles: [c.jobRoleArn, c.executionRoleArn, ...roles].filter((r): r is string => !!r), env: c.environment ?? [], secrets: c.secrets ?? [], logGroup });
  };
  plain(d.containerProperties, []);
  for (const n of d.nodeProperties?.nodeRangeProperties ?? []) plain(n.container, []);
  for (const t of d.ecsProperties?.taskProperties ?? []) for (const c of t.containers ?? []) plain(c, [t.taskRoleArn, t.executionRoleArn]);
  for (const c of d.eksProperties?.podProperties?.containers ?? []) out.push({ image: c.image, roles: [], env: c.env ?? [], secrets: [] });
  return out;
}

// A container secret's valueFrom: a Secrets Manager ARN (maybe with a JSON key / version), an SSM parameter ARN, or a
// parameter name in the job's region. The reference only — never a value.
function secretRef(valueFrom: string | undefined, region: string, account: string | undefined): string | undefined {
  const v = valueFrom?.trim();
  if (!v) return undefined;
  if (v.startsWith("arn:")) {
    const p = parseArn(v);
    if (p?.service === "secretsmanager") return v.split(":").slice(0, 7).join(":");
    return v;
  }
  return account ? arnOf.ssmParameter(region, account, v) : undefined;
}

// What a job definition's containers say, as links and mentions from the queue that runs it.
function definitionLinks(from: string, d: RawJobDefinition, region: string, account: string | undefined, confidence: Link["confidence"], why: string): { links: Link[]; mentions: Mention[] } {
  const links: Link[] = [];
  const mentions: Mention[] = [];
  const name = definitionLabel(d.jobDefinitionArn) ?? d.jobDefinitionName ?? "job definition";
  const ev = `job definition ${name} (${why})`;
  const add = (l: Link) => links.push(confidence === "config" ? l : { ...l, confidence });
  for (const c of containersOf(d)) {
    const repo = ecrRepoRef(c.image);
    if (repo) add({ from, to: repo, kind: "pulls", label: `image (${name})`, evidence: `${ev}: image ${clip(c.image!, 200)}` });
    for (const r of c.roles) {
      const role = roleRef(r, account, region);
      if (role?.startsWith("arn:")) add({ from, to: role, kind: "assumes", label: `job role (${name})`, evidence: `${ev}: role` });
    }
    for (const s of c.secrets) {
      const ref = secretRef(s.valueFrom, region, account);
      if (ref) add({ from, to: ref, kind: "reads", label: s.name ? `secret ${s.name}` : "secret", evidence: `${ev}: secrets valueFrom` });
    }
    const lg = logGroupRef(c.logGroup, region, account);
    if (lg) add({ from, to: lg, kind: "logs", label: "job logs", evidence: `${ev}: awslogs-group` });
    const vars = Object.fromEntries(c.env.filter((e) => e.name && e.value !== undefined).map((e) => [e.name!, e.value!]));
    mentions.push(...envMentions(from, vars, `job definition ${d.jobDefinitionName ?? name} env`));
  }
  return { links, mentions };
}

// ---------- health ----------

function envHealth(c: RawComputeEnvironment): { health: Health; reason?: string } {
  const why = c.statusReason ? `: ${clip(c.statusReason, 160)}` : "";
  if (c.status === "INVALID") return { health: "error", reason: `invalid${why}` };
  if (c.state === "DISABLED") return { health: "stopped", reason: "disabled" };
  if (c.status === "CREATING" || c.status === "UPDATING") return { health: "warning", reason: STATUS_WORD(c.status) };
  if (c.status === "DELETING" || c.status === "DELETED") return { health: "stopped", reason: STATUS_WORD(c.status) };
  if (c.status === "VALID" && c.state === "ENABLED") return { health: "ok" };
  return { health: "unknown", reason: c.status ? `status ${c.status}` : "status not reported" };
}

// The oldest RUNNABLE job of a queue and how long it has waited.
export function oldestRunnable(jobs: RawJob[] | undefined, now: number): { job: RawJob; waitedMs: number } | undefined {
  let best: RawJob | undefined;
  for (const j of jobs ?? []) if (j.createdAt !== undefined && (!best || j.createdAt < best.createdAt!)) best = j;
  return best ? { job: best, waitedMs: now - best.createdAt! } : undefined;
}

function queueHealth(q: RawJobQueue, now: number): { health: Health; reason?: string } {
  const why = q.statusReason ? `: ${clip(q.statusReason, 160)}` : "";
  if (q.status === "INVALID") return { health: "error", reason: `invalid${why}` };
  if (q.state === "DISABLED") return { health: "stopped", reason: "disabled" };
  if (q.status === "CREATING" || q.status === "UPDATING") return { health: "warning", reason: STATUS_WORD(q.status) };
  if (q.status === "DELETING" || q.status === "DELETED") return { health: "stopped", reason: STATUS_WORD(q.status) };
  if (q.status !== "VALID" || q.state !== "ENABLED") return { health: "unknown", reason: q.status ? `status ${q.status}` : "status not reported" };
  const runnable = q.jobs?.runnable ?? [];
  const old = runnable.filter((j) => j.createdAt !== undefined && now - j.createdAt > RUNNABLE_WARN_MS);
  if (old.length) {
    const oldest = oldestRunnable(old, now)!;
    const n = q.jobs?.more?.runnable && old.length === runnable.length ? `${old.length}+ jobs` : plural(old.length, "job");
    return { health: "warning", reason: `${n} waiting for capacity over 1 h (oldest ${ago(oldest.waitedMs)})` };
  }
  return { health: "ok" };
}

// The newest moment any listed job of the queue was created, started or stopped.
export function newestJobAt(jobs: QueueJobs | undefined): number | undefined {
  let best: number | undefined;
  for (const j of [...(jobs?.runnable ?? []), ...(jobs?.running ?? []), ...(jobs?.failed ?? []), ...(jobs?.succeeded ?? [])]) {
    for (const t of [j.createdAt, j.startedAt, j.stoppedAt]) if (t !== undefined && (best === undefined || t > best)) best = t;
  }
  return best;
}

// A queue's last activity: now while a listed job waits or runs (a job stuck RUNNABLE for weeks still means someone
// uses the queue), else the newest listed job. Undefined when no job was listed (Batch keeps finished jobs about a week).
export const queueActivityAt = (jobs: QueueJobs | undefined, now: number): number | undefined =>
  jobs?.runnable?.length || jobs?.running?.length ? now : newestJobAt(jobs);

export function batchConsoleUrl(region: string, what: "compute-environments" | "queues", name: string) {
  return `https://${region}.console.aws.amazon.com/batch/home?region=${region}#${what}/detail/${encodeURIComponent(name)}`;
}

const envKey = (c: RawComputeEnvironment, region: string, account: string | undefined) =>
  c.computeEnvironmentArn ?? (c.computeEnvironmentName && account ? arnOf.batchEnvironment(region, account, c.computeEnvironmentName) : undefined);
const queueKey = (q: RawJobQueue, region: string, account: string | undefined) =>
  q.jobQueueArn ?? (q.jobQueueName && account ? arnOf.batchQueue(region, account, q.jobQueueName) : undefined);

// A compute environment named by a queue: its ARN, or a name in the queue's region and account.
const envRef = (ref: string | undefined, region: string, account: string | undefined) =>
  !ref ? undefined : ref.startsWith("arn:") ? ref : account ? arnOf.batchEnvironment(region, account, ref) : undefined;

const TYPE_WORD: Record<string, string> = { EC2: "On-Demand EC2", SPOT: "Spot EC2", FARGATE: "Fargate", FARGATE_SPOT: "Fargate Spot" };

// ---------- result ----------

export function batchResult(input: BatchInput, o: { region: string; account?: string; now: number }): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  const envByKey = new Map<string, RawComputeEnvironment>();

  for (const c of input.environments) {
    const key = envKey(c, o.region, o.account);
    const p = key ? parseArn(key) : undefined;
    if (!key || !p) continue;
    envByKey.set(key, c);
    const region = p.region;
    const account = p.account || o.account;
    const { health, reason } = envHealth(c);
    const cr = c.computeResources;
    const facts: Facts = {};
    if (c.state) facts.state = c.state;
    const vcpus = cr ? `min ${cr.minvCpus ?? 0} · desired ${cr.desiredvCpus ?? 0} · max ${cr.maxvCpus ?? "?"}` : c.unmanagedvCpus !== undefined ? `${c.unmanagedvCpus} (unmanaged)` : undefined;
    resources.push({
      key,
      kind: "batch-environment",
      provider: "batch",
      name: c.computeEnvironmentName ?? arnName(key),
      region,
      ...tagsOf(c.tags ?? {}), // DescribeComputeEnvironments returns them
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(cr?.subnets?.length ? { subnetIds: [...cr.subnets] } : {}),
      ...(cr?.securityGroupIds?.length ? { securityGroups: [...cr.securityGroupIds] } : {}),
      props: props([
        { label: "Type", value: `${c.type === "UNMANAGED" ? "unmanaged" : "managed"}${cr?.type ? ` · ${TYPE_WORD[cr.type] ?? cr.type}` : ""}${envPlatform(c) === "EKS" ? " · on EKS" : ""}` },
        { label: "State", value: c.state && c.status ? `${c.state.toLowerCase()} · ${STATUS_WORD(c.status)}` : c.state ?? c.status },
        { label: "vCPUs", value: vcpus },
        { label: "Instance types", value: cr?.instanceTypes?.length ? clip(cr.instanceTypes.join(", "), 160) : undefined },
        { label: "Allocation", value: cr?.allocationStrategy ? STATUS_WORD(cr.allocationStrategy) : undefined },
        { label: "Spot bid", value: cr?.bidPercentage !== undefined && cr.type === "SPOT" ? `${cr.bidPercentage} % of On-Demand` : undefined },
        // Batch's own ECS cluster: a prop, not a link (those clusters aren't environments or nodes).
        { label: "ECS cluster", value: c.ecsClusterArn ? arnName(c.ecsClusterArn) : undefined, mono: true },
        { label: "Reason", value: c.statusReason && health !== "ok" ? clip(c.statusReason, 200) : undefined },
      ]),
      consoleUrl: batchConsoleUrl(region, "compute-environments", c.computeEnvironmentName ?? arnName(key)),
    });
    const profile = profileRef(cr?.instanceRole, account, region);
    if (profile) links.push({ from: key, to: profile, kind: "assumes", label: "instance role", evidence: "compute environment computeResources.instanceRole" });
    for (const [r, label, field] of [[c.serviceRole, "service role", "serviceRole"], [cr?.spotIamFleetRole, "Spot fleet role", "computeResources.spotIamFleetRole"]] as const) {
      const role = roleRef(r, account, region);
      if (role?.startsWith("arn:")) links.push({ from: key, to: role, kind: "assumes", label, evidence: `compute environment ${field}` });
    }
    if (c.eksConfiguration?.eksClusterArn) links.push({ from: key, to: c.eksConfiguration.eksClusterArn, kind: "uses", label: `runs on EKS${c.eksConfiguration.kubernetesNamespace ? ` (${c.eksConfiguration.kubernetesNamespace})` : ""}`, evidence: "compute environment eksConfiguration" });
  }

  // Job definitions: the latest ACTIVE revision of each, and every revision a listed job names.
  const defsByArn = new Map<string, RawJobDefinition>();
  const latest = new Map<string, RawJobDefinition>();
  for (const d of input.definitions ?? []) {
    if (!d.jobDefinitionArn || (d.status && d.status !== "ACTIVE")) continue;
    defsByArn.set(d.jobDefinitionArn, d);
    const n = d.jobDefinitionName ?? d.jobDefinitionArn;
    if (!latest.has(n) || (latest.get(n)!.revision ?? 0) < (d.revision ?? 0)) latest.set(n, d);
  }
  const seen = new Set<string>(); // definition names a listed job used, anywhere in the region
  const queueKeys: { key: string; platforms: Set<string> }[] = [];

  for (const q of input.queues) {
    const key = queueKey(q, o.region, o.account);
    const p = key ? parseArn(key) : undefined;
    if (!key || !p) continue;
    const region = p.region;
    const account = p.account || o.account;
    const { health, reason } = queueHealth(q, o.now);
    const order = [...(q.computeEnvironmentOrder ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const envs = order.map((e) => envRef(e.computeEnvironment, region, account)).filter((e): e is string => !!e);
    const platforms = new Set(envs.map((e) => envByKey.get(e)).filter((e): e is RawComputeEnvironment => !!e).map(envPlatform));
    queueKeys.push({ key, platforms });
    const jobsRead = q.enrichment?.jobs === undefined || q.enrichment.jobs === "ok";
    const runnable = q.jobs?.runnable ?? [];
    const failed = q.jobs?.failed ?? [];
    const running = q.jobs?.running ?? [];
    const waiting = oldestRunnable(runnable, o.now);
    const last = newestJobAt(q.jobs);
    const activeAt = queueActivityAt(q.jobs, o.now);
    const facts: Facts = {};
    if (q.state) facts.state = q.state;
    const enrichment = enrichmentOf(q.enrichment);
    const count = (list: RawJob[], more?: boolean) => `${list.length}${more ? "+" : ""}`;
    resources.push({
      key,
      kind: "batch-queue",
      provider: "batch",
      name: q.jobQueueName ?? arnName(key),
      region,
      ...tagsOf(q.tags ?? {}), // DescribeJobQueues returns them
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      aliases: q.jobQueueName ? [q.jobQueueName] : [],
      ...(activeAt !== undefined ? { lastActivityAt: activeAt } : {}),
      props: props([
        { label: "State", value: q.state && q.status ? `${q.state.toLowerCase()} · ${STATUS_WORD(q.status)}` : q.state ?? q.status },
        { label: "Priority", value: q.priority !== undefined ? String(q.priority) : undefined },
        { label: "Compute environments", value: envs.length ? clip(envs.map((e) => arnName(e)).join(" → "), 200) : undefined },
        { label: "Waiting jobs", value: jobsRead ? (runnable.length ? `${count(runnable, q.jobs?.more?.runnable)} runnable${waiting ? ` · oldest ${ago(waiting.waitedMs)}` : ""}` : "none") : unread("jobs", q.enrichment?.jobs) },
        { label: "Running jobs", value: jobsRead && running.length ? count(running, q.jobs?.more?.running) : undefined },
        { label: "Failed jobs", value: jobsRead && failed.length ? `${count(failed, q.jobs?.more?.failed)} recently` : undefined },
        { label: "Last job", value: last !== undefined ? fmtTime(last) : undefined },
        { label: "Scheduling policy", value: q.schedulingPolicyArn ? arnName(q.schedulingPolicyArn) : undefined },
        { label: "Reason", value: q.statusReason && health !== "ok" && q.status !== "VALID" ? clip(q.statusReason, 200) : undefined },
      ]),
      consoleUrl: batchConsoleUrl(region, "queues", q.jobQueueName ?? arnName(key)),
    });
    order.forEach((e, i) => {
      const to = envs[i];
      if (to) links.push({ from: key, to, kind: "uses", label: `compute environment ${e.order ?? i + 1}`, evidence: "job queue computeEnvironmentOrder" });
    });
    // The definitions this queue's listed jobs ran (the exact revision each job names).
    const ran = new Map<string, RawJob>();
    for (const j of [...runnable, ...running, ...failed, ...(q.jobs?.succeeded ?? [])]) if (j.jobDefinition && !ran.has(j.jobDefinition)) ran.set(j.jobDefinition, j);
    for (const [arn, j] of ran) {
      const d = defsByArn.get(arn);
      if (!d) continue;
      seen.add(d.jobDefinitionName ?? arn);
      const r = definitionLinks(key, d, region, account, "config", `job ${j.jobName ?? j.jobId ?? "?"}`);
      links.push(...r.links);
      mentions.push(...r.mentions);
    }
  }

  // A definition no listed job used: drawn from the queue that must run it — the only queue of the region whose
  // compute environments offer its platform. Ambiguous (several queues) or none: only the panel lists it.
  for (const [name, d] of latest) {
    if (seen.has(name)) continue;
    const fits = queueKeys.filter((q) => q.platforms.has(definitionPlatform(d)));
    if (fits.length !== 1) continue;
    const region = parseArn(fits[0].key)?.region ?? o.region;
    const r = definitionLinks(fits[0].key, d, region, parseArn(fits[0].key)?.account || o.account, "allowed", "the only queue that can run it");
    links.push(...r.links);
    mentions.push(...r.mentions);
  }
  return { resources, links, mentions };
}

// ---------- detail ----------

const jobRow = (j: RawJob, status: string, now: number): string[] => [
  j.jobName ?? j.jobId ?? "—",
  status.toLowerCase(),
  j.createdAt !== undefined ? `${fmtTime(j.createdAt)} (${ago(now - j.createdAt)} ago)` : "—",
  definitionLabel(j.jobDefinition) ?? "—",
  j.statusReason ? clip(j.statusReason, 160) : "",
];

export function batchEnvironmentDetail(key: string, c: RawComputeEnvironment | undefined): ResourceDetail {
  if (!c) return { key, sections: [{ title: "Compute environment", note: "This compute environment no longer exists." }] };
  const cr = c.computeResources;
  return {
    key,
    sections: [
      {
        title: "Compute environment",
        rows: props([
          { label: "Name", value: c.computeEnvironmentName },
          { label: "Type", value: c.type },
          { label: "Resources", value: cr?.type ? TYPE_WORD[cr.type] ?? cr.type : undefined },
          { label: "State", value: c.state },
          { label: "Status", value: c.status },
          { label: "Reason", value: c.statusReason },
          { label: "ECS cluster", value: c.ecsClusterArn, mono: true },
          { label: "EKS cluster", value: c.eksConfiguration?.eksClusterArn, mono: true },
          { label: "Instance role", value: cr?.instanceRole, mono: true },
          { label: "Service role", value: c.serviceRole, mono: true },
          { label: "Subnets", value: cr?.subnets?.join(", "), mono: true },
          { label: "Security groups", value: cr?.securityGroupIds?.join(", "), mono: true },
        ]),
      },
    ],
  };
}

export function batchQueueDetail(key: string, q: RawJobQueue | undefined, o: { now: number; recent?: { status: string; jobs: RawJob[] }[]; definitions?: RawJobDefinition[] }): ResourceDetail {
  if (!q) return { key, sections: [{ title: "Job queue", note: "This job queue no longer exists." }] };
  const jobs = (o.recent ?? []).flatMap((r) => r.jobs.map((j) => ({ j, status: r.status }))).sort((a, b) => (b.j.createdAt ?? 0) - (a.j.createdAt ?? 0)).slice(0, 25);
  const used = new Set(jobs.map((x) => x.j.jobDefinition).filter((x): x is string => !!x));
  const defs = (o.definitions ?? []).filter((d) => d.jobDefinitionArn && used.has(d.jobDefinitionArn));
  return {
    key,
    sections: [
      {
        title: "Job queue",
        rows: props([
          { label: "Name", value: q.jobQueueName },
          { label: "State", value: q.state },
          { label: "Status", value: q.status },
          { label: "Reason", value: q.statusReason },
          { label: "Priority", value: q.priority !== undefined ? String(q.priority) : undefined },
          { label: "Scheduling policy", value: q.schedulingPolicyArn, mono: true },
        ]),
      },
      {
        title: "Compute environments",
        table: { columns: ["Order", "Compute environment"], rows: [...(q.computeEnvironmentOrder ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((e) => [String(e.order ?? "—"), arnName(e.computeEnvironment) || "—"]) },
      },
      jobs.length
        ? { title: "Recent jobs", table: { columns: ["Job", "Status", "Created", "Definition", "Reason"], rows: jobs.map((x) => jobRow(x.j, x.status, o.now)) } }
        : { title: "Recent jobs", note: "No recent jobs." },
      ...(defs.length
        ? [{
          title: "Job definitions",
          // Images and roles only: environment values may hold secrets and are never shown.
          table: { columns: ["Definition", "Image", "Role"], rows: defs.map((d) => { const c = containersOf(d)[0]; return [definitionLabel(d.jobDefinitionArn) ?? "—", c?.image ?? "—", c?.roles[0] ? arnName(c.roles[0]) : "—"]; }) },
        }]
        : []),
    ],
  };
}
