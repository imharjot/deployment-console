// EKS, per region: clusters (version, endpoint, network, access mode, nodegroups, Fargate profiles, add-ons) with links
// to their EC2 nodes, their roles, secrets-encryption KMS key and control-plane log group, and — when the cluster's API
// answers and the console's IAM role has Kubernetes read access — the workloads inside: Deployments, StatefulSets and
// DaemonSets (→ eks-workload nodes, keyed "@<region>" outside home), Ingresses routing to them, Service load balancer
// hostnames as endpoints, and container env values as mentions. Without access, a note says how to grant it and the
// cluster-level map still stands; the clusters are handed over before the Kubernetes reads (R18). Actions: scale a
// managed nodegroup, rollout-restart or scale a workload — each after a live read of the cluster's tags (and the
// workload's labels) (R01).
import "server-only";
import {
  DescribeClusterCommand, DescribeNodegroupCommand, EKSClient, ListAddonsCommand, ListClustersCommand, ListFargateProfilesCommand, ListNodegroupsCommand,
  UpdateNodegroupConfigCommand, type Cluster, type Nodegroup,
} from "@aws-sdk/client-eks";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { ratesFrom } from "../../costs.ts";
import { propOf } from "../../inventory/compute-common.ts";
import { capacityDelta } from "../../inventory/compute-ec2.ts";
import {
  EDIT_POLICY, RESTARTABLE, SCALABLE, SYSTEM_NAMESPACES, clusterLinks, clusterResource, isNodeOf, k8sAccessNote, mapK8s, nodeLink, nodegroupScalingProblem,
  parseWorkloadKey, restartPatch, workloadPath, workloadScaleProblem, workloadTags, type ClusterView, type K8sObjects, type NodegroupView, type WorkloadSummary,
} from "../../inventory/compute-eks.ts";
import type { Link, Mention, Resource, ResourceDetail } from "../../inventory/types.ts";
import { consoleConfig } from "../discovery.ts";
import { HttpError, errText } from "../errors.ts";
import { LIMITS } from "../../config.ts";
import { abortOpts, call, ms, optional, regional, sdkConfig, tagMap } from "./compute-util.ts";
import { field } from "./edge-util.ts";
import { K8sError, eksToken, k8s, k8sList, type K8sTarget } from "./k8s.ts";
import { MOCK_REGION, mockScaleNodegroup, mockWorkload } from "./mock/compute-state.ts";
import { mockInstances } from "./mock/ec2.ts";
import { mockClusters, mockK8s } from "./mock/eks.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const eks = regional((region) => new EKSClient(sdkConfig(region)), "eks");
const eksWrite = regional((region) => new EKSClient(sdkConfig(region, { maxAttempts: 1 })), "eks"); // sent once (F31)
const ec2 = regional((region) => new EC2Client(sdkConfig(region)), "ec2");
// A cluster or workload is read and changed in its own region (a workload key's "@region", else the resource's).
const regionOf = (r: Resource, ctx: { region: string }) => parseWorkloadKey(r.key)?.region ?? (r.region && r.region !== "global" ? r.region : ctx.region);
const LIVE = ["pending", "running", "stopping", "stopped"];

// Last discovery's per-workload panel data (no env values) and per-cluster Kubernetes access outcome, for detail().
interface Memory { summaries: Map<string, WorkloadSummary>; access: Map<string, string> }
const g = globalThis as { __computeEks?: Memory };
const memory = (): Memory => (g.__computeEks ??= { summaries: new Map(), access: new Map() });

const systemNamespaces = () => (/^(1|true|yes)$/i.test(process.env.CONSOLE_EKS_SYSTEM_NAMESPACES ?? "") ? new Set<string>() : new Set(SYSTEM_NAMESPACES));

// ---------- real API → views ----------

function nodegroupView(n: Nodegroup): NodegroupView {
  return {
    name: n.nodegroupName!, status: n.status ?? "UNKNOWN", min: n.scalingConfig?.minSize ?? 0, desired: n.scalingConfig?.desiredSize ?? 0, max: n.scalingConfig?.maxSize ?? 0,
    instanceTypes: n.instanceTypes ?? [], amiType: n.amiType, capacityType: n.capacityType, asgs: (n.resources?.autoScalingGroups ?? []).map((a) => a.name!).filter(Boolean),
    issues: (n.health?.issues ?? []).map((i) => `${i.code}: ${i.message ?? ""}`.trim()),
  };
}

function clusterView(c: Cluster, nodegroups: NodegroupView[], fargate: string[], addons: string[]): ClusterView {
  const v = c.resourcesVpcConfig;
  return {
    name: c.name!, arn: c.arn!, status: c.status ?? "UNKNOWN", version: c.version, platformVersion: c.platformVersion, endpoint: c.endpoint, vpcId: v?.vpcId,
    subnetIds: v?.subnetIds ?? [], securityGroups: [...new Set([v?.clusterSecurityGroupId, ...(v?.securityGroupIds ?? [])].filter((x): x is string => !!x))],
    publicAccess: v?.endpointPublicAccess, privateAccess: v?.endpointPrivateAccess, authMode: c.accessConfig?.authenticationMode, tags: c.tags ?? {},
    createdAt: ms(c.createdAt), nodegroups, fargateProfiles: fargate, addons, issues: (c.health?.issues ?? []).map((i) => `${i.code}: ${i.message ?? ""}`.trim()),
    roleArn: c.roleArn, kmsKeys: (c.encryptionConfig ?? []).flatMap((e) => (e.provider?.keyArn ? [e.provider.keyArn] : [])),
    logTypes: (c.logging?.clusterLogging ?? []).filter((x) => x.enabled).flatMap((x) => x.types ?? []),
  };
}

async function listAll<T>(ctx: ProviderContext, page: (token?: string) => Promise<{ items?: T[]; next?: string }>, max = 500): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await page(token);
    out.push(...(r.items ?? []));
    token = r.next;
  } while (token && out.length < max);
  return out.slice(0, max);
}

interface Discovered { view: ClusterView; ca?: string }

async function describeOne(ctx: ProviderContext, name: string): Promise<Discovered> {
  const c = eks(ctx.region);
  const cl = (await call(ctx, (o) => c.send(new DescribeClusterCommand({ name }), o))).cluster!;
  const [ngNames, fargate, addons] = await Promise.all([
    optional(ctx, `eks: nodegroups of ${name}`, () => listAll(ctx, async (nextToken) => {
      const r = await call(ctx, (o) => c.send(new ListNodegroupsCommand({ clusterName: name, maxResults: 100, nextToken }), o));
      return { items: r.nodegroups, next: r.nextToken };
    }), [] as string[]),
    optional(ctx, `eks: Fargate profiles of ${name}`, () => listAll(ctx, async (nextToken) => {
      const r = await call(ctx, (o) => c.send(new ListFargateProfilesCommand({ clusterName: name, maxResults: 100, nextToken }), o));
      return { items: r.fargateProfileNames, next: r.nextToken };
    }), [] as string[]),
    optional(ctx, `eks: add-ons of ${name}`, () => listAll(ctx, async (nextToken) => {
      const r = await call(ctx, (o) => c.send(new ListAddonsCommand({ clusterName: name, maxResults: 100, nextToken }), o));
      return { items: r.addons, next: r.nextToken };
    }), [] as string[]),
  ]);
  const ngs = await Promise.all(ngNames.map((nodegroupName) => optional(ctx, `eks: nodegroup ${name}/${nodegroupName}`, async () =>
    nodegroupView((await call(ctx, (o) => c.send(new DescribeNodegroupCommand({ clusterName: name, nodegroupName }), o))).nodegroup!), undefined)));
  return { view: clusterView(cl, ngs.filter((x): x is NodegroupView => !!x), fargate, addons), ca: cl.certificateAuthority?.data };
}

async function clustersReal(ctx: ProviderContext): Promise<Discovered[]> {
  const names = await listAll(ctx, async (nextToken) => {
    const r = await call(ctx, (o) => eks(ctx.region).send(new ListClustersCommand({ maxResults: 100, nextToken }), o));
    return { items: r.clusters, next: r.nextToken };
  }, ctx.cap);
  return Promise.all(names.map((name) => describeOne(ctx, name)));
}

// Every EC2 instance that is some cluster's node, in one paged call (tag keys EKS, Karpenter and self-managed nodes use).
async function nodesReal(ctx: ProviderContext, clusters: string[]): Promise<{ id: string; tags: Record<string, string> }[]> {
  if (!clusters.length) return [];
  const keysFilter = ["eks:cluster-name", "eks:eks-cluster-name", ...clusters.map((n) => `kubernetes.io/cluster/${n}`)].slice(0, 200);
  const out: { id: string; tags: Record<string, string> }[] = [];
  let NextToken: string | undefined;
  do {
    const r = await call(ctx, (o) => ec2(ctx.region).send(new DescribeInstancesCommand({ Filters: [{ Name: "tag-key", Values: keysFilter }, { Name: "instance-state-name", Values: LIVE }], MaxResults: 1000, NextToken }), o));
    for (const i of (r.Reservations ?? []).flatMap((x) => x.Instances ?? [])) out.push({ id: i.InstanceId!, tags: tagMap(i.Tags) });
    NextToken = r.NextToken;
  } while (NextToken && out.length < ctx.cap);
  return out;
}

// ---------- Kubernetes workloads ----------

const PATHS: [keyof K8sObjects, string][] = [
  ["deployments", "/apis/apps/v1/deployments"], ["statefulsets", "/apis/apps/v1/statefulsets"], ["daemonsets", "/apis/apps/v1/daemonsets"],
  ["services", "/api/v1/services"], ["ingresses", "/apis/networking.k8s.io/v1/ingresses"],
];

async function k8sObjects(c: Discovered, ctx: ProviderContext): Promise<K8sObjects | undefined> {
  const v = c.view;
  if (v.status !== "ACTIVE" || !v.endpoint || !c.ca) return undefined;
  const fail = (e: unknown) => {
    const k = e as K8sError;
    const note = k8sAccessNote(v.name, { status: k.status, code: k.code ?? (k.status ? undefined : errText(e)) }, { publicAccess: v.publicAccess, authMode: v.authMode });
    memory().access.set(v.arn, note);
    ctx.note(note);
    return undefined;
  };
  let t: K8sTarget;
  try {
    t = { endpoint: v.endpoint, ca: c.ca, token: await eksToken(v.name, ctx.region) };
  } catch (e) {
    ctx.note(`eks: couldn't sign a Kubernetes token for ${v.name} (${errText(e)}) — workloads not shown`);
    return undefined;
  }
  const cap = Math.min(ctx.cap, 2_000);
  const res = await Promise.allSettled(PATHS.map(([, p]) => k8sList<unknown>(t, p, cap, ctx.signal)));
  const firstErr = res.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (res.every((r) => r.status === "rejected")) return fail(firstErr!.reason);
  const out: K8sObjects = { deployments: [], statefulsets: [], daemonsets: [], services: [], ingresses: [] };
  res.forEach((r, i) => {
    const [kind] = PATHS[i];
    if (r.status === "rejected") return ctx.note(`eks: ${v.name}: ${kind} not listed (${(r.reason as Error).message}) — the console's Kubernetes role needs list on ${kind}`);
    if (r.value.truncated) ctx.note(`eks: ${v.name}: showing the first ${cap.toLocaleString("en-US")} ${kind}`);
    Object.assign(out, { [kind]: r.value.items });
  });
  memory().access.set(v.arn, `Workloads listed ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`);
  return out;
}

// ---------- discover ----------

async function discover(ctx: ProviderContext) {
  const region = ctx.region;
  if (ctx.mock && region !== MOCK_REGION) return { resources: [], links: [], mentions: [] }; // the simulated cluster is in the home region
  const found: Discovered[] = ctx.mock ? mockClusters().map((view) => ({ view, ca: "mock" })) : await clustersReal(ctx);
  const nodes = ctx.mock
    ? mockInstances().map((i) => ({ id: i.id, tags: i.tags }))
    : await optional(ctx, "eks: cluster nodes", () => nodesReal(ctx, found.map((c) => c.view.name)), []);
  const resources: Resource[] = [], links: Link[] = [], mentions: Mention[] = [];
  for (const c of found) {
    resources.push(clusterResource(c.view, region));
    links.push(...clusterLinks(c.view, region, ctx.accountId));
    for (const n of nodes.filter((x) => isNodeOf(c.view.name, x.tags))) links.push(nodeLink(c.view.arn, n.id, n.tags, region, ctx.home));
  }
  // R18: the clusters first; the Kubernetes API (one round trip per kind and cluster) may be slow or unreachable.
  ctx.checkpoint?.({ resources: [...resources], links: [...links], mentions: [] });
  const skip = systemNamespaces();
  for (const c of found) {
    const objs = ctx.mock ? mockK8s() : await k8sObjects(c, ctx);
    if (ctx.mock) memory().access.set(c.view.arn, "Workloads listed (simulated cluster).");
    if (!objs) continue;
    const m = mapK8s({ name: c.view.name, arn: c.view.arn, region, home: ctx.home, vpcId: c.view.vpcId, subnetIds: c.view.subnetIds, tags: c.view.tags }, objs, skip);
    resources.push(...m.resources);
    links.push(...m.links);
    mentions.push(...m.mentions);
    for (const [k, s] of m.summaries) memory().summaries.set(k, s);
  }
  return { resources, links, mentions };
}

// R01: what protection reads, live, right before an action — the cluster's tags, and for a workload its labels plus
// the cluster's console:* tags (the same mix discovery gives it).
async function authoritative(r: Resource, ctx: ActionContext): Promise<{ tags: Record<string, string> }> {
  const w = parseWorkloadKey(r.key);
  const cluster = w?.cluster ?? r.name;
  // A cluster without tags may answer without the field: that is "no tags", not "not found".
  const found = ctx.mock
    ? mockClusters().find((c) => c.name === cluster)
    : (await eks(regionOf(r, ctx)).send(new DescribeClusterCommand({ name: cluster }), abortOpts())).cluster;
  if (!found) throw new HttpError(404, `cluster ${cluster} not found`);
  const clusterTags = found.tags ?? {};
  if (!w) return { tags: { ...clusterTags } };
  const labels = ctx.mock
    ? mockLabels(w)
    : (await k8sCall<{ metadata?: { labels?: Record<string, string> } }>(w.cluster, "GET", workloadPath(w), undefined, "", ctx, regionOf(r, ctx))).metadata?.labels;
  return { tags: workloadTags(labels, clusterTags) };
}

function mockLabels(w: { namespace: string; kind: string; name: string }): Record<string, string> | undefined {
  const o = mockK8s();
  const list = w.kind === "Deployment" ? o.deployments : w.kind === "StatefulSet" ? o.statefulsets : w.kind === "DaemonSet" ? o.daemonsets : [];
  const found = list.find((x) => x.metadata.name === w.name && (x.metadata.namespace ?? "default") === w.namespace);
  if (!found) throw new HttpError(404, "the workload no longer exists");
  return found.metadata.labels;
}

// ---------- detail ----------

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  if (r.kind === "eks-workload") {
    const s = memory().summaries.get(r.key);
    if (!s) return { key: r.key, sections: [{ title: "Workload", note: propOf(r, "Kind") === "Ingress" ? "Routes are listed on the map; backends appear as edges." : "Not in the last discovery — refresh the map." }] };
    return {
      key: r.key,
      sections: [
        { title: "Containers", table: { columns: ["Container", "Image", "Ports", "Env (names)"], rows: s.containers.map((c) => [c.name, c.image, c.ports, c.env]) } },
        { title: "Workload", rows: [{ label: "Services", value: s.services.join(", ") || "none" }, { label: "Conditions", value: s.conditions.join(", ") || "—" }, ...(s.restartedAt ? [{ label: "Last restart", value: s.restartedAt }] : [])] },
      ],
    };
  }
  const found = ctx.mock ? mockClusters().find((c) => c.arn === r.key) : (await describeOne(ctx, r.name)).view;
  if (!found) throw new HttpError(404, `cluster ${r.name} not found`);
  return {
    key: r.key,
    sections: [
      {
        title: "Nodegroups",
        table: { columns: ["Nodegroup", "Status", "Instance types", "Min / desired / max", "AMI", "Capacity"], rows: found.nodegroups.map((n) => [n.name, n.status, n.instanceTypes.join(", "), `${n.min} / ${n.desired} / ${n.max}`, n.amiType ?? "", n.capacityType ?? ""]) },
        note: found.nodegroups.length ? undefined : "No managed nodegroups (self-managed nodes, Karpenter or Fargate only).",
      },
      { title: "Add-ons & Fargate", rows: [{ label: "Add-ons", value: found.addons.join(", ") || "none" }, { label: "Fargate profiles", value: found.fargateProfiles.join(", ") || "none" }] },
      {
        title: "Kubernetes access",
        rows: [{ label: "Authentication mode", value: found.authMode ?? "?" }, { label: "Endpoint access", value: `${found.publicAccess ? "public" : ""}${found.publicAccess && found.privateAccess ? " + " : ""}${found.privateAccess ? "private" : ""}` || "?" }],
        note: memory().access.get(r.key) ?? "To show workloads, give the console's IAM role an EKS access entry with AmazonEKSViewPolicy (cluster scope); restart / scale actions need AmazonEKSEditPolicy.",
      },
    ],
  };
}

// ---------- actions ----------

async function nodegroupLive(cluster: string, nodegroup: string, ctx: ActionContext): Promise<NodegroupView> {
  if (ctx.mock) {
    const n = mockClusters().find((c) => c.name === cluster)?.nodegroups.find((x) => x.name === nodegroup);
    if (!n) throw new HttpError(404, `nodegroup ${nodegroup} not found in ${cluster}`);
    return n;
  }
  try {
    return nodegroupView((await eks(ctx.region).send(new DescribeNodegroupCommand({ clusterName: cluster, nodegroupName: nodegroup }), abortOpts())).nodegroup!);
  } catch (e) {
    if ((e as Error).name === "ResourceNotFoundException") throw new HttpError(404, `nodegroup ${nodegroup} not found in ${cluster}`);
    throw e;
  }
}

type ScaleNg = { nodegroup: string; min: number; desired: number; max: number };
async function checkNodegroup(r: Resource, i: ScaleNg, ctx: ActionContext) {
  const bad = nodegroupScalingProblem(i.min, i.desired, i.max);
  if (bad) throw new HttpError(400, bad);
  const n = await nodegroupLive(r.name, i.nodegroup, { ...ctx, region: regionOf(r, ctx) });
  if (n.status !== "ACTIVE") throw new HttpError(409, `nodegroup ${n.name} is ${n.status} — wait until it is ACTIVE`);
  if (n.min === i.min && n.desired === i.desired && n.max === i.max) throw new HttpError(409, `nodegroup ${n.name} is already min ${i.min} / desired ${i.desired} / max ${i.max}`);
  return n;
}

const NAME = "^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$";
const size = (title: string, minimum: number, description: string) => field({ type: "integer", title, minimum, maximum: 1000, description });
const scaleNodegroup: ProviderAction<ScaleNg> = {
  id: "scale-nodegroup", kind: "eks-cluster", title: "Scale nodegroup",
  summary: "Changes how many nodes one managed nodegroup runs (min, desired, max); removed nodes are drained first.",
  description: "Changes a managed nodegroup's min / desired / max size (UpdateNodegroupConfig). EKS then adds nodes or drains and removes them (pods are evicted and rescheduled). Needs min ≤ desired ≤ max and max ≥ 1; refuses a nodegroup that is not ACTIVE. The plan shows the monthly list-price change. Returns the update id.",
  risk: "change", perm: "provision",
  iam: ["eks:UpdateNodegroupConfig"],
  undo: "Scale the nodegroup back to the previous sizes (the plan shows them); drained nodes are replaced by new ones, not restored",
  verifies: "The nodegroup is ACTIVE again with the new desired count of nodes",
  retrySafe: true, // the same sizes twice end in the same nodegroup
  input: {
    type: "object", additionalProperties: false, required: ["nodegroup", "min", "desired", "max"],
    properties: {
      nodegroup: field({ type: "string", title: "Nodegroup", pattern: NAME, description: "Nodegroup name (see the cluster's Nodegroup … properties)." }),
      min: size("Minimum nodes", 0, "Smallest size the nodegroup may scale to."),
      desired: size("Desired nodes", 0, "Nodes to run now (between min and max)."),
      max: size("Maximum nodes", 1, "Largest size the nodegroup may scale to (at least 1)."),
    },
  },
  when: (r) => (r.props.some((p) => p.label.startsWith("Nodegroup ")) ? undefined : "this cluster has no managed nodegroups"),
  async plan(r, i, ctx) {
    const n = await checkNodegroup(r, i, ctx);
    const type = n.instanceTypes[0];
    const warnings: string[] = [];
    if (i.desired < n.desired) warnings.push(`${n.desired - i.desired} node${n.desired - i.desired === 1 ? "" : "s"} drain: pods are evicted and rescheduled; pods with no room left stay Pending.`);
    if (i.desired === 0) warnings.push("Zero nodes: every pod scheduled on this nodegroup stops.");
    if (n.instanceTypes.length > 1) warnings.push(`Several instance types (${n.instanceTypes.join(", ")}): the estimate uses ${type}.`);
    warnings.push("If cluster-autoscaler or Karpenter manages this nodegroup it may change the count again.");
    return {
      summary: `Scale nodegroup ${r.name}/${n.name}: min ${n.min}→${i.min}, desired ${n.desired}→${i.desired}, max ${n.max}→${i.max}`,
      changes: [`UpdateNodegroupConfig ${r.name}/${n.name} scalingConfig { minSize: ${i.min}, desiredSize: ${i.desired}, maxSize: ${i.max} }`], warnings,
      estimate: capacityDelta(type, n.desired, i.desired, ratesFrom(consoleConfig().config.pricing, r.region)),
    };
  },
  async run(r, i, ctx) {
    await checkNodegroup(r, i, ctx);
    if (ctx.mock) return { cluster: r.name, nodegroup: i.nodegroup, ...mockScaleNodegroup(i.min, i.desired, i.max) };
    const res = await eksWrite(regionOf(r, ctx)).send(
      new UpdateNodegroupConfigCommand({ clusterName: r.name, nodegroupName: i.nodegroup, scalingConfig: { minSize: i.min, desiredSize: i.desired, maxSize: i.max } }),
      { abortSignal: AbortSignal.timeout(LIMITS.awsWriteTimeoutMs) },
    );
    return { cluster: r.name, nodegroup: i.nodegroup, updateId: res.update?.id ?? "" };
  },
};

const article = (w: string) => `${/^[AEIOU]/i.test(w) ? "an" : "a"} ${w}`;

function workloadOf(r: Resource) {
  const w = parseWorkloadKey(r.key);
  if (!w) throw new HttpError(400, "not a Kubernetes workload");
  return w;
}

// The API server of the workload's cluster (in its own region), with a fresh token.
async function targetFor(cluster: string, region: string): Promise<K8sTarget> {
  const c = (await eks(region).send(new DescribeClusterCommand({ name: cluster }), abortOpts())).cluster;
  if (!c?.endpoint || !c.certificateAuthority?.data) throw new HttpError(409, `cluster ${cluster} has no reachable API endpoint`);
  return { endpoint: c.endpoint, ca: c.certificateAuthority.data, token: await eksToken(cluster, region) };
}

// One Kubernetes API call on a workload of `cluster`; 401/403/404 become what a person can act on.
async function k8sCall<T>(cluster: string, method: "GET" | "PATCH", path: string, body: unknown, contentType: string, ctx: ActionContext, region = ctx.region): Promise<T> {
  try {
    return await k8s<T>(await targetFor(cluster, region), method, path, body === undefined ? {} : { body, contentType });
  } catch (e) {
    const k = e as K8sError;
    if (k.status === 401 || k.status === 403)
      throw new HttpError(403, method === "GET"
        ? `the console's IAM role may not read workloads in ${cluster} — associate the view policy with its access entry`
        : `the console's IAM role may not change workloads in ${cluster} — associate ${EDIT_POLICY} with its access entry (a namespace scope is enough)`);
    if (k.status === 404) throw new HttpError(404, "the workload no longer exists");
    throw e;
  }
}

const K8S_IAM = ["eks:DescribeCluster"]; // the API endpoint and token; the change itself is Kubernetes RBAC (AmazonEKSEditPolicy)

const rolloutRestart: ProviderAction = {
  id: "rollout-restart", kind: "eks-workload", title: "Rollout restart",
  summary: "Replaces this workload's pods one batch at a time, like kubectl rollout restart.",
  description: "Restarts a Deployment, StatefulSet or DaemonSet the way `kubectl rollout restart` does: sets the pod template annotation kubectl.kubernetes.io/restartedAt, so Kubernetes replaces its pods by its rollout strategy. Needs Kubernetes patch access (AmazonEKSEditPolicy). Returns the workload and the restart time.",
  risk: "change", perm: "act",
  iam: K8S_IAM,
  undo: "Nothing to undo — the same pod spec comes back with new pods",
  verifies: "Every replica updated and ready again (the rollout completes)",
  retrySafe: false, // each run restarts the pods again
  input: { type: "object", additionalProperties: false, properties: {} },
  when: (r) => (RESTARTABLE.includes(propOf(r, "Kind") ?? "") ? undefined : `${article(propOf(r, "Kind") ?? "resource")} has no pods to restart`),
  async plan(r) {
    const w = workloadOf(r);
    if (!RESTARTABLE.includes(w.kind)) throw new HttpError(409, `${article(w.kind)} has no pods to restart`);
    return {
      summary: `Restart ${w.namespace}/${w.name} (${w.kind} in ${w.cluster}) — rolling`,
      changes: [`PATCH ${workloadPath(w)} spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`],
      warnings: [w.kind === "StatefulSet" ? "StatefulSet pods restart one at a time, highest ordinal first." : "Pods are replaced by the rollout strategy (maxUnavailable / maxSurge)."],
    };
  },
  async run(r, _i, ctx) {
    const w = workloadOf(r);
    if (!RESTARTABLE.includes(w.kind)) throw new HttpError(409, `${article(w.kind)} has no pods to restart`);
    const at = new Date().toISOString();
    if (ctx.mock) mockWorkload(w.namespace, w.name).restartedAt = Date.parse(at);
    else await k8sCall(w.cluster, "PATCH", workloadPath(w), restartPatch(at), "application/strategic-merge-patch+json", ctx, regionOf(r, ctx));
    return { cluster: w.cluster, namespace: w.namespace, kind: w.kind, name: w.name, restartedAt: at };
  },
};

async function currentReplicas(w: { cluster: string; namespace: string; kind: string; name: string }, ctx: ActionContext, region: string): Promise<number> {
  if (ctx.mock) return mockWorkload(w.namespace, w.name).replicas;
  const s = await k8sCall<{ spec?: { replicas?: number } }>(w.cluster, "GET", workloadPath(w, "/scale"), undefined, "", ctx, region);
  return s.spec?.replicas ?? 0;
}

const scaleWorkload: ProviderAction<{ replicas: number }> = {
  id: "scale-workload", kind: "eks-workload", title: "Scale replicas",
  summary: "Sets how many pods this Deployment or StatefulSet runs, like kubectl scale.",
  description: "Sets a Deployment's or StatefulSet's replica count (0–50) through its scale subresource, like `kubectl scale`. A HorizontalPodAutoscaler on it may change the count again. Needs Kubernetes patch access (AmazonEKSEditPolicy). Returns the workload and the new count.",
  risk: "change", perm: "act",
  iam: K8S_IAM,
  undo: "Scale it back to the previous replica count (the plan shows it)",
  verifies: "The new number of replicas is ready",
  retrySafe: true, // the same count twice is the same workload
  input: {
    type: "object", additionalProperties: false, required: ["replicas"],
    properties: { replicas: field({ type: "integer", title: "Replicas", minimum: 0, maximum: 50, description: "New replica count." }) },
  },
  when: (r) => (SCALABLE.includes(propOf(r, "Kind") ?? "") ? undefined : `${article(propOf(r, "Kind") ?? "resource")} can't be scaled`),
  async plan(r, i, ctx) {
    const w = workloadOf(r);
    const bad = workloadScaleProblem(w.kind, i.replicas);
    if (bad) throw new HttpError(400, bad);
    const cur = await currentReplicas(w, ctx, regionOf(r, ctx));
    if (cur === i.replicas) throw new HttpError(409, `${w.name} already has ${cur} replicas`);
    return {
      summary: `Scale ${w.namespace}/${w.name} (${w.kind} in ${w.cluster}) from ${cur} to ${i.replicas} replicas`,
      changes: [`PATCH ${workloadPath(w, "/scale")} spec.replicas = ${i.replicas}`],
      warnings: [
        ...(i.replicas === 0 ? ["Zero replicas: the workload stops serving."] : []),
        ...(i.replicas > cur ? ["New pods need room on the nodes; without it they stay Pending (scale the nodegroup first)."] : []),
        "If a HorizontalPodAutoscaler targets it, the autoscaler may change the count again.",
      ],
    };
  },
  async run(r, i, ctx) {
    const w = workloadOf(r);
    const bad = workloadScaleProblem(w.kind, i.replicas);
    if (bad) throw new HttpError(400, bad);
    if (ctx.mock) {
      const m = mockWorkload(w.namespace, w.name);
      Object.assign(m, { prev: m.replicas, replicas: i.replicas, changedAt: Date.now() });
      return { cluster: w.cluster, namespace: w.namespace, kind: w.kind, name: w.name, replicas: i.replicas };
    }
    await k8sCall(w.cluster, "PATCH", workloadPath(w, "/scale"), { spec: { replicas: i.replicas } }, "application/merge-patch+json", ctx, regionOf(r, ctx));
    return { cluster: w.cluster, namespace: w.namespace, kind: w.kind, name: w.name, replicas: i.replicas };
  },
};

export const eksProvider: Provider = {
  id: "eks",
  label: "EKS",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["eks-cluster", "eks-workload"],
  covers: ["eks:cluster"],
  read: ["eks:ListClusters", "eks:DescribeCluster", "eks:ListNodegroups", "eks:DescribeNodegroup", "eks:ListFargateProfiles", "eks:ListAddons", "ec2:DescribeInstances"],
  write: ["eks:UpdateNodegroupConfig"],
  discover,
  authoritative,
  detail,
  actions: [scaleNodegroup as ProviderAction, rolloutRestart, scaleWorkload as ProviderAction],
};
