// Pure rules for the EKS provider (src/lib/server/providers/eks.ts): the bearer token `aws eks get-token` builds from a
// presigned STS URL, Kubernetes objects → map resources, links and mentions, replica health, nodegroup / replica
// validation, what a cluster is wired to (its roles, secrets-encryption KMS key, control-plane log group), and the note
// that explains how to grant the console read access. No network, so node:test runs them.
import { arnOf } from "./arn.ts";
import { envMentions, kmsRef, prop, props, roleRef, uniq } from "./compute-common.ts";
import { keys, type Health, type Link, type Mention, type Resource } from "./types.ts";

// ---------- token ----------

export const TOKEN_PREFIX = "k8s-aws-v1.";
export const TOKEN_TTL_S = 60;
export const CLUSTER_ID_HEADER = "x-k8s-aws-id";
export const stsHost = (region: string) => `sts.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;

// RFC 3986 (SigV4's canonical form): encodeURIComponent leaves !'()* unescaped.
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// The URL of a presigned request (@smithy/protocol-http HttpRequest after SignatureV4.presign).
export function presignedUrl(req: { protocol?: string; hostname: string; port?: number; path?: string; query?: Record<string, string | string[] | null | undefined> }): string {
  const q = Object.entries(req.query ?? {})
    .flatMap(([k, v]) => (v === null || v === undefined ? [] : [v].flat().map((x) => `${rfc3986(k)}=${rfc3986(x)}`)))
    .sort()
    .join("&");
  const proto = (req.protocol ?? "https:").replace(/:?$/, ":");
  return `${proto}//${req.hostname}${req.port ? `:${req.port}` : ""}${req.path || "/"}${q ? `?${q}` : ""}`;
}

// base64url without padding, as aws-iam-authenticator expects. ASCII input (a URL), so btoa is safe.
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const tokenFromUrl = (url: string) => TOKEN_PREFIX + b64url(url);

// ---------- Kubernetes objects (the fields we read) ----------

export interface K8sMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
}
interface K8sEnv { name: string; value?: string; valueFrom?: unknown }
export interface K8sContainer { name: string; image?: string; env?: K8sEnv[]; ports?: { containerPort?: number; name?: string; protocol?: string }[] }
interface K8sCondition { type: string; status: string; reason?: string; message?: string }
export interface K8sWorkload {
  metadata: K8sMeta;
  spec?: {
    replicas?: number;
    template?: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: { containers?: K8sContainer[]; initContainers?: K8sContainer[]; serviceAccountName?: string } };
  };
  status?: {
    readyReplicas?: number; updatedReplicas?: number; availableReplicas?: number; // Deployment, StatefulSet
    desiredNumberScheduled?: number; numberReady?: number; updatedNumberScheduled?: number; // DaemonSet
    conditions?: K8sCondition[];
  };
}
interface LbStatus { loadBalancer?: { ingress?: { hostname?: string; ip?: string }[] } }
interface Backend { service?: { name: string; port?: { number?: number; name?: string } } }
export interface K8sService { metadata: K8sMeta; spec?: { type?: string; selector?: Record<string, string>; ports?: { port?: number; name?: string }[] }; status?: LbStatus }
export interface K8sIngress {
  metadata: K8sMeta;
  spec?: { ingressClassName?: string; defaultBackend?: Backend; rules?: { host?: string; http?: { paths?: { path?: string; backend?: Backend }[] } }[] };
  status?: LbStatus;
}

export const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet"] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];
export const RESTARTABLE: readonly string[] = WORKLOAD_KINDS;
export const SCALABLE: readonly string[] = ["Deployment", "StatefulSet"];
export const MAX_REPLICAS = 50;
// Namespaces Kubernetes and EKS run their own components in; listed only when asked (CONSOLE_EKS_SYSTEM_NAMESPACES=true).
export const SYSTEM_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease"];

// ---------- health ----------

export function replicaHealth(kind: WorkloadKind, w: K8sWorkload): { health: Health; healthReason?: string; desired: number; ready: number } {
  const ds = kind === "DaemonSet";
  const desired = ds ? (w.status?.desiredNumberScheduled ?? 0) : (w.spec?.replicas ?? 1);
  const ready = (ds ? w.status?.numberReady : w.status?.readyReplicas) ?? 0;
  const updated = (ds ? w.status?.updatedNumberScheduled : w.status?.updatedReplicas) ?? ready;
  const stuck = w.status?.conditions?.find((c) => c.type === "Progressing" && c.status === "False");
  const r = (health: Health, healthReason?: string) => ({ health, healthReason, desired, ready });
  if (stuck) return r("error", `rollout stuck: ${stuck.reason ?? stuck.message ?? "not progressing"}`);
  if (desired === 0) return ds ? r("warning", "scheduled on no nodes") : r("stopped", "scaled to 0 replicas");
  if (ready >= desired && updated >= desired) return r("ok");
  if (ready === 0) return r("error", `0/${desired} ready`);
  if (updated < desired) return r("warning", `rolling out: ${updated}/${desired} updated, ${ready} ready`);
  return r("warning", `${ready}/${desired} ready`);
}

// A Service selects pods whose labels contain every selector pair. No selector = selects nothing (manual endpoints).
export function selectorMatches(selector?: Record<string, string>, labels?: Record<string, string>): boolean {
  const s = Object.entries(selector ?? {});
  return s.length > 0 && s.every(([k, v]) => labels?.[k] === v);
}

// ---------- mapping ----------

// home: the console's home region — workloads of a cluster elsewhere get an "@<region>" key suffix, like the ECS keys
// (CC-6), so two clusters of one name in two regions never share a workload key. tags: the cluster's own, whose
// console:* entries (console:protected, console:self) every workload inherits.
export interface ClusterRef { name: string; arn: string; region: string; home?: string; vpcId?: string; subnetIds?: string[]; tags?: Record<string, string> }

// keys.eksWorkload, with "@<region>" outside the home region.
export const workloadKey = (c: Pick<ClusterRef, "name" | "region" | "home">, namespace: string, kind: string, name: string) =>
  `${keys.eksWorkload(c.name, namespace, kind, name)}${c.home && c.region && c.region !== c.home ? `@${c.region}` : ""}`;
const consoleTags = (t?: Record<string, string>) => Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => k.startsWith("console:")));
export interface K8sObjects { deployments: K8sWorkload[]; statefulsets: K8sWorkload[]; daemonsets: K8sWorkload[]; services: K8sService[]; ingresses: K8sIngress[] }
// What a workload's panel shows (no env values): kept by the provider between discovery runs.
export interface WorkloadSummary {
  kind: string;
  namespace: string;
  containers: { name: string; image: string; ports: string; env: string }[]; // env = variable names only
  services: string[];
  conditions: string[];
  restartedAt?: string;
}
export interface K8sMapped { resources: Resource[]; links: Link[]; mentions: Mention[]; summaries: Map<string, WorkloadSummary> }

const lbHosts = (s?: LbStatus) => uniq((s?.loadBalancer?.ingress ?? []).flatMap((x) => [x.hostname, x.ip]));
const svcKey = (ns: string, name: string) => `${ns}/${name}`;
const consoleUrl = (c: ClusterRef, path: string, ns: string) =>
  `https://${c.region}.console.aws.amazon.com/eks/home?region=${c.region}#/clusters/${encodeURIComponent(c.name)}/${path}?namespace=${encodeURIComponent(ns)}`;
const ms = (t?: string) => (t && Number.isFinite(Date.parse(t)) ? Date.parse(t) : undefined);

export function mapK8s(c: ClusterRef, o: K8sObjects, skip: Set<string>): K8sMapped {
  const out: K8sMapped = { resources: [], links: [], mentions: [], summaries: new Map() };
  const keep = (m: K8sMeta) => !skip.has(m.namespace ?? "default");
  const all: { kind: WorkloadKind; w: K8sWorkload; r: Resource }[] = [];
  const lists: [WorkloadKind, K8sWorkload[]][] = [["Deployment", o.deployments], ["StatefulSet", o.statefulsets], ["DaemonSet", o.daemonsets]];
  for (const [kind, list] of lists) {
    for (const w of list.filter((x) => keep(x.metadata))) {
      const ns = w.metadata.namespace ?? "default";
      const key = workloadKey(c, ns, kind, w.metadata.name);
      const h = replicaHealth(kind, w);
      const containers = w.spec?.template?.spec?.containers ?? [];
      const r: Resource = {
        key, kind: "eks-workload", provider: "eks", name: w.metadata.name, region: c.region, tags: { ...(w.metadata.labels ?? {}), ...consoleTags(c.tags) },
        health: h.health, healthReason: h.healthReason,
        props: props(
          prop("Kind", kind), prop("Namespace", ns), prop("Cluster", c.name),
          prop("Replicas", kind === "DaemonSet" ? `${h.ready}/${h.desired} nodes ready` : `${h.ready}/${h.desired} ready`),
          prop("Images", uniq(containers.map((x) => x.image)).join(", "), true),
          prop("Service account", w.spec?.template?.spec?.serviceAccountName),
        ),
        vpcId: c.vpcId, subnetIds: c.subnetIds, endpoints: [], aliases: [],
        consoleUrl: consoleUrl(c, `${kind.toLowerCase()}s/${encodeURIComponent(w.metadata.name)}`, ns), createdAt: ms(w.metadata.creationTimestamp),
      };
      all.push({ kind, w, r });
      out.resources.push(r);
      out.links.push({ from: c.arn, to: key, kind: "uses", label: "runs", evidence: `Kubernetes ${kind} in namespace ${ns}` });
      for (const x of [...containers, ...(w.spec?.template?.spec?.initContainers ?? [])]) out.mentions.push(...envMentions(key, x.env ?? []));
      out.summaries.set(key, {
        kind, namespace: ns,
        containers: containers.map((x) => ({
          name: x.name, image: x.image ?? "", ports: (x.ports ?? []).map((p) => `${p.containerPort}${p.protocol && p.protocol !== "TCP" ? `/${p.protocol}` : ""}`).join(", "),
          env: (x.env ?? []).map((e) => e.name).join(", "),
        })),
        services: [], conditions: (w.status?.conditions ?? []).map((x) => `${x.type}=${x.status}${x.reason ? ` (${x.reason})` : ""}`),
        restartedAt: w.spec?.template?.metadata?.annotations?.["kubectl.kubernetes.io/restartedAt"],
      });
    }
  }

  // Services: which workloads each selects; their cluster DNS names become aliases (env vars in other workloads point at
  // them). A load balancer's hostname belongs to the load balancer node (the elb provider lists every ALB/NLB, and an
  // endpoint two nodes claim resolves to neither), so it becomes a Link from that hostname plus an alias — which the
  // inventory only falls back to when no load balancer answers to the name.
  const selected = new Map<string, typeof all>();
  for (const s of o.services.filter((x) => keep(x.metadata))) {
    const ns = s.metadata.namespace ?? "default";
    const mine = all.filter((x) => (x.w.metadata.namespace ?? "default") === ns && selectorMatches(s.spec?.selector, x.w.spec?.template?.metadata?.labels));
    selected.set(svcKey(ns, s.metadata.name), mine);
    const lb = s.spec?.type === "LoadBalancer" ? lbHosts(s.status) : [];
    for (const x of mine) {
      x.r.aliases = uniq([...(x.r.aliases ?? []), `${s.metadata.name}.${ns}.svc.cluster.local`, `${s.metadata.name}.${ns}.svc`, ...lb]);
      for (const h of lb) out.links.push({ from: h, to: x.r.key, kind: "route", label: `Service ${s.metadata.name}`, evidence: `Kubernetes Service ${ns}/${s.metadata.name} of type LoadBalancer` });
      out.summaries.get(x.r.key)?.services.push(`${s.metadata.name}${s.spec?.type && s.spec.type !== "ClusterIP" ? ` (${s.spec.type})` : ""}`);
    }
  }

  for (const ing of o.ingresses.filter((x) => keep(x.metadata))) {
    const ns = ing.metadata.namespace ?? "default";
    const key = workloadKey(c, ns, "Ingress", ing.metadata.name);
    const address = lbHosts(ing.status);
    const hosts = uniq((ing.spec?.rules ?? []).map((x) => x.host));
    const backends: { label: string; svc: string }[] = [];
    const add = (host: string | undefined, path: string | undefined, b?: Backend) => {
      if (b?.service?.name) backends.push({ svc: b.service.name, label: `${host ?? "*"}${path ?? "/"} → ${b.service.name}:${b.service.port?.number ?? b.service.port?.name ?? ""}`.replace(/:$/, "") });
    };
    add(undefined, undefined, ing.spec?.defaultBackend);
    for (const rule of ing.spec?.rules ?? []) for (const p of rule.http?.paths ?? []) add(rule.host, p.path, p.backend);
    out.resources.push({
      key, kind: "eks-workload", provider: "eks", name: ing.metadata.name, region: c.region, tags: { ...(ing.metadata.labels ?? {}), ...consoleTags(c.tags) },
      health: address.length ? "ok" : "warning", healthReason: address.length ? undefined : "no load balancer address yet",
      props: props(
        prop("Kind", "Ingress"), prop("Namespace", ns), prop("Cluster", c.name), prop("Class", ing.spec?.ingressClassName),
        prop("Hosts", hosts.join(", "), true), prop("Address", address.join(", "), true), prop("Backends", uniq(backends.map((b) => b.label)).join(", ")),
      ),
      vpcId: c.vpcId, endpoints: hosts, aliases: address,
      consoleUrl: consoleUrl(c, `ingresses/${encodeURIComponent(ing.metadata.name)}`, ns), createdAt: ms(ing.metadata.creationTimestamp),
    });
    out.links.push({ from: c.arn, to: key, kind: "uses", label: "ingress", evidence: `Kubernetes Ingress in namespace ${ns}` });
    for (const h of address) out.links.push({ from: h, to: key, kind: "route", label: "load balancer", evidence: `Ingress ${ns}/${ing.metadata.name} status: load balancer address` });
    const seen = new Set<string>();
    for (const b of backends) {
      for (const x of selected.get(svcKey(ns, b.svc)) ?? []) {
        if (seen.has(x.r.key)) continue;
        seen.add(x.r.key);
        out.links.push({ from: key, to: x.r.key, kind: "route", label: b.label, evidence: `Ingress backend service ${b.svc} selects this ${x.kind}` });
      }
    }
  }
  return out;
}

// ---------- validation ----------

export function nodegroupScalingProblem(min: number, desired: number, max: number): string | undefined {
  if (![min, desired, max].every((n) => Number.isInteger(n) && n >= 0)) return "min, desired and max must be whole numbers, 0 or more";
  if (max < 1) return "max must be at least 1 (EKS requires it)";
  if (max > 1000) return "max can be at most 1000";
  if (min > desired || desired > max) return `need min ≤ desired ≤ max (got ${min} ≤ ${desired} ≤ ${max})`;
  return undefined;
}

export function workloadScaleProblem(kind: string, replicas: number): string | undefined {
  if (!SCALABLE.includes(kind)) return `${/^[AEIOU]/i.test(kind) ? "an" : "a"} ${kind} can't be scaled — only Deployments and StatefulSets have a replica count`;
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > MAX_REPLICAS) return `replicas must be a whole number from 0 to ${MAX_REPLICAS}`;
  return undefined;
}

// workloadKey(…) back into its parts ("@<region>" outside home → region).
export function parseWorkloadKey(key: string): { cluster: string; namespace: string; kind: string; name: string; region?: string } | undefined {
  const m = /^eks:([^/@]+)\/([^/@]+)\/([^/@]+)\/([^/@]+)(?:@([a-z0-9-]+))?$/.exec(key);
  return m ? { cluster: m[1], namespace: m[2], kind: m[3], name: m[4], ...(m[5] ? { region: m[5] } : {}) } : undefined;
}

// Labels and the cluster's console:* tags — what protection reads for a workload (live before an action, R01).
export const workloadTags = (labels: Record<string, string> | undefined, clusterTags: Record<string, string> | undefined) => ({ ...(labels ?? {}), ...consoleTags(clusterTags) });

// PATCH paths and bodies for the two workload actions (apps/v1).
export const workloadPath = (w: { namespace: string; kind: string; name: string }, sub = "") =>
  `/apis/apps/v1/namespaces/${encodeURIComponent(w.namespace)}/${w.kind.toLowerCase()}s/${encodeURIComponent(w.name)}${sub}`;
export const restartPatch = (at: string) => ({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": at } } } } });

// ---------- access help ----------

export const VIEW_POLICY = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";
export const EDIT_POLICY = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy";

// What to tell people when the Kubernetes API refused or couldn't be reached. `status` = HTTP status, `code` = socket error.
export function k8sAccessNote(cluster: string, p: { status?: number; code?: string }, c: { publicAccess?: boolean; authMode?: string }): string {
  const grant =
    `aws eks create-access-entry --cluster-name ${cluster} --principal-arn <console role ARN>; ` +
    `aws eks associate-access-policy --cluster-name ${cluster} --principal-arn <console role ARN> --policy-arn ${VIEW_POLICY} --access-scope type=cluster`;
  const mode = c.authMode === "CONFIG_MAP" ? " (the cluster only reads the aws-auth ConfigMap: switch its authentication mode to API_AND_CONFIG_MAP first, or map the role there)" : "";
  if (p.status === 401) return `eks: ${cluster} doesn't know the console's IAM role, so its workloads aren't shown. Grant read access with an EKS access entry: ${grant}${mode}. Cluster-level details are still shown.`;
  if (p.status === 403) return `eks: the console's IAM role may sign in to ${cluster} but can't list workloads. Associate the view policy: ${grant.split("; ")[1]}. Cluster-level details are still shown.`;
  const why = p.status ? `HTTP ${p.status}` : (p.code ?? "no answer");
  const fix = c.publicAccess === false
    ? "its API endpoint is private: run the console inside the cluster's VPC (or a peered one) and allow the console's security group on 443 in the cluster security group"
    : "check the endpoint's public access CIDRs include the console's egress address";
  return `eks: ${cluster}'s Kubernetes API isn't reachable from the console (${why}) — ${fix}. Cluster-level details are still shown.`;
}

// ---------- clusters ----------

export interface NodegroupView {
  name: string;
  status: string; // ACTIVE | UPDATING | DEGRADED | CREATING | DELETING | CREATE_FAILED …
  min: number;
  desired: number;
  max: number;
  instanceTypes: string[];
  amiType?: string;
  capacityType?: string; // ON_DEMAND | SPOT
  asgs: string[];
  issues: string[];
  nodeRole?: string; // the nodes' IAM role ARN
}
export interface ClusterView {
  name: string;
  arn: string;
  status: string; // ACTIVE | CREATING | UPDATING | DELETING | FAILED | PENDING
  version?: string;
  platformVersion?: string;
  endpoint?: string; // https://…eks.amazonaws.com
  vpcId?: string;
  subnetIds: string[];
  securityGroups: string[]; // cluster security group + additional ones
  publicAccess?: boolean;
  privateAccess?: boolean;
  authMode?: string; // API | API_AND_CONFIG_MAP | CONFIG_MAP
  tags: Record<string, string>;
  createdAt?: number;
  nodegroups: NodegroupView[];
  fargateProfiles: string[];
  addons: string[];
  issues: string[];
  roleArn?: string; // the cluster's service role
  kmsKeys?: string[]; // envelope encryption of Kubernetes secrets (encryptionConfig[].provider.keyArn)
  logTypes?: string[]; // control-plane log types enabled (api, audit, authenticator…) → /aws/eks/<name>/cluster
}

export const nodegroupLine = (n: NodegroupView) =>
  `${n.desired} × ${n.instanceTypes.join("/") || "?"} · min ${n.min} / max ${n.max}${n.amiType ? ` · ${n.amiType}` : ""}${n.capacityType ? ` · ${n.capacityType}` : ""}${n.status !== "ACTIVE" ? ` · ${n.status}` : ""}`;

export function clusterHealth(c: Pick<ClusterView, "status" | "issues" | "nodegroups">): { health: Health; healthReason?: string } {
  if (c.status === "FAILED") return { health: "error", healthReason: "cluster failed" };
  if (c.status !== "ACTIVE") return { health: "warning", healthReason: c.status.toLowerCase() };
  if (c.issues.length) return { health: "warning", healthReason: c.issues[0] };
  const bad = c.nodegroups.find((n) => n.status !== "ACTIVE" && n.status !== "UPDATING");
  if (bad) return { health: bad.status.includes("FAILED") ? "error" : "warning", healthReason: `nodegroup ${bad.name} ${bad.status.toLowerCase()}${bad.issues[0] ? `: ${bad.issues[0]}` : ""}` };
  const updating = c.nodegroups.find((n) => n.status === "UPDATING");
  if (updating) return { health: "warning", healthReason: `nodegroup ${updating.name} updating` };
  return { health: "ok" };
}

const hostOf = (url?: string) => url?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || undefined;

export function clusterResource(c: ClusterView, region: string): Resource {
  const h = clusterHealth(c);
  const access = c.publicAccess && c.privateAccess ? "public and private" : c.publicAccess ? "public" : c.privateAccess ? "private only" : undefined;
  return {
    key: c.arn, kind: "eks-cluster", provider: "eks", name: c.name, region, tags: c.tags, health: h.health, healthReason: h.healthReason,
    props: props(
      prop("Kubernetes version", c.version ? `${c.version}${c.platformVersion ? ` (${c.platformVersion})` : ""}` : undefined), prop("Status", c.status),
      prop("API endpoint", hostOf(c.endpoint), true), prop("Endpoint access", access), prop("Authentication mode", c.authMode),
      ...c.nodegroups.map((n) => prop(`Nodegroup ${n.name}`, nodegroupLine(n))),
      prop("Fargate profiles", c.fargateProfiles.join(", ")), prop("Add-ons", c.addons.join(", ")),
      prop("Control-plane logs", c.logTypes?.length ? c.logTypes.join(", ") : c.logTypes ? "off" : undefined),
      prop("Secrets encryption", c.kmsKeys?.length ? "KMS envelope encryption" : undefined),
    ),
    vpcId: c.vpcId, subnetIds: c.subnetIds.length ? c.subnetIds : undefined, securityGroups: c.securityGroups.length ? c.securityGroups : undefined,
    endpoints: uniq([hostOf(c.endpoint)]), aliases: [c.name], createdAt: c.createdAt,
    consoleUrl: `https://${region}.console.aws.amazon.com/eks/home?region=${region}#/clusters/${encodeURIComponent(c.name)}`,
  };
}

// EC2 instances that are this cluster's nodes (managed nodegroups, self-managed nodes, Karpenter).
export function isNodeOf(cluster: string, tags: Record<string, string>): boolean {
  return tags["eks:cluster-name"] === cluster || tags["eks:eks-cluster-name"] === cluster || `kubernetes.io/cluster/${cluster}` in tags;
}

// What the cluster is wired to: its service role and the nodegroups' node roles (assumes), the KMS key that encrypts its
// Kubernetes secrets (encrypts), and its control-plane log group when any log type is on (logs).
export function clusterLinks(c: ClusterView, region: string, account?: string): Link[] {
  const out: Link[] = [];
  const role = roleRef(c.roleArn, account, region);
  if (role) out.push({ from: c.arn, to: role, kind: "assumes", label: "cluster role", evidence: "cluster roleArn" });
  for (const n of c.nodegroups) {
    const r = roleRef(n.nodeRole, account, region);
    if (r) out.push({ from: c.arn, to: r, kind: "assumes", label: `node role · ${n.name}`, evidence: `nodegroup ${n.name} nodeRole` });
  }
  for (const k of c.kmsKeys ?? []) {
    const key = kmsRef(k, region, account);
    if (key) out.push({ from: key, to: c.arn, kind: "encrypts", label: "Kubernetes secrets", evidence: "encryptionConfig provider keyArn (secrets)" });
  }
  if (c.logTypes?.length && account) {
    out.push({ from: c.arn, to: arnOf.logGroup(region, account, `/aws/eks/${c.name}/cluster`), kind: "logs", label: "control plane", evidence: `control-plane logging: ${c.logTypes.join(", ")}` });
  }
  return mergeAssumes(out);
}
// One assumes edge per role (several nodegroups often share a node role): labels joined.
function mergeAssumes(links: Link[]): Link[] {
  const out: Link[] = [];
  for (const l of links) {
    const same = out.find((x) => x.kind === l.kind && x.from === l.from && x.to === l.to);
    if (same) {
      same.label = `${same.label}, ${l.label}`;
      same.evidence = `${same.evidence}; ${l.evidence}`;
    } else out.push({ ...l });
  }
  return out;
}

// region / home: the node's key gets "@<region>" outside the home region, like the EC2 provider's (CC-6).
export const nodeLink = (clusterArn: string, instanceId: string, tags: Record<string, string>, region?: string, home?: string): Link => ({
  from: clusterArn, to: keys.ec2(instanceId, region, home), kind: "uses",
  label: tags["eks:nodegroup-name"] ? `node · ${tags["eks:nodegroup-name"]}` : "node",
  evidence: tags["eks:nodegroup-name"] ? `instance tag eks:nodegroup-name=${tags["eks:nodegroup-name"]}` : "instance tagged as a cluster node",
});
