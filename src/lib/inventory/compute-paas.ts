// Pure rules for the App Runner and Elastic Beanstalk providers (src/lib/server/providers/apprunner.ts, beanstalk.ts):
// health from what each service reports, what they run as and pull from (roles, instance profiles, ECR, KMS), a
// Beanstalk environment's resources → links, its option settings → network placement and env-value mentions, and
// version validation. No AWS calls, so node:test runs them.
import { ecrRepoRef, envMentions, kmsRef, profileRef, prop, props, roleRef, uniq } from "./compute-common.ts";
import { keys, type EnrichState, type Health, type Link, type Mention, type Resource } from "./types.ts";

// ---------- App Runner ----------

export function apprunnerHealth(status: string): { health: Health; healthReason?: string } {
  switch (status) {
    case "RUNNING": return { health: "ok" };
    case "PAUSED": return { health: "stopped", healthReason: "paused" };
    case "OPERATION_IN_PROGRESS": return { health: "warning", healthReason: "operation in progress" };
    case "CREATE_FAILED": return { health: "error", healthReason: "creation failed" };
    case "DELETE_FAILED": return { health: "error", healthReason: "deletion failed" };
    default: return { health: "unknown", healthReason: status.toLowerCase() };
  }
}

// ---------- Elastic Beanstalk ----------

export interface BeanstalkFacts {
  status: string; // Launching | Updating | Ready | Terminating | Terminated | LinkingFrom | LinkingTo | Aborting
  health?: string; // Green | Yellow | Red | Grey
  healthStatus?: string; // Ok | Info | Warning | Degraded | Severe | Pending | Unknown | Suspended (enhanced health)
  cause?: string; // DescribeEnvironmentHealth → Causes[0]
}

export function beanstalkHealth(e: BeanstalkFacts): { health: Health; healthReason?: string } {
  if (e.status === "Terminated") return { health: "stopped", healthReason: "terminated" };
  if (e.status !== "Ready") return { health: "warning", healthReason: e.status.toLowerCase() };
  const why = e.cause ?? `health ${e.health ?? "unknown"}${e.healthStatus ? ` (${e.healthStatus})` : ""}`;
  switch (e.health) {
    case "Green": return { health: "ok" };
    case "Yellow": return { health: "warning", healthReason: why };
    case "Red": return { health: "error", healthReason: why };
    default: return { health: "unknown", healthReason: why };
  }
}

// DescribeEnvironmentResources names an ALB/NLB by ARN and a Classic LB by name; the console keys load balancers by name.
export function lbName(nameOrArn: string): string {
  const m = /:loadbalancer\/(?:app|net|gwy)\/([^/]+)\//.exec(nameOrArn);
  return m ? m[1] : nameOrArn;
}

export interface BeanstalkResources { autoScalingGroups: string[]; instances: string[]; loadBalancers: string[]; queues: { name?: string; url?: string }[] }

// Links from what Beanstalk created for the environment. ASGs and queues are referenced by name / URL and resolved by
// the inventory like mentions; instances and load balancers use the console's own keys.
// region / home: load balancer and instance keys get "@<region>" outside the home region (CC-6), like their providers'.
export function beanstalkLinks(envKey: string, r: BeanstalkResources, region?: string, home?: string): Link[] {
  const ev = "Elastic Beanstalk environment resources";
  return [
    ...r.loadBalancers.map((lb): Link => ({ from: keys.loadBalancer(lbName(lb), region, home), to: envKey, kind: "route", label: "load balancer", evidence: ev })),
    ...r.autoScalingGroups.map((g): Link => ({ from: envKey, to: g, kind: "uses", label: "Auto Scaling group", evidence: ev })),
    ...r.instances.map((id): Link => ({ from: envKey, to: keys.ec2(id, region, home), kind: "uses", label: "instance", evidence: ev })),
    ...r.queues.filter((q) => q.url).map((q): Link => ({ from: envKey, to: q.url!, kind: "poll", label: "worker queue", evidence: `${ev} (worker tier${q.name ? ` · ${q.name}` : ""})` })),
  ];
}

export interface OptionSetting { Namespace?: string; OptionName?: string; Value?: string }
const ENV_NS = "aws:elasticbeanstalk:application:environment";
const opt = (o: OptionSetting[], ns: string, name: string) => o.find((x) => x.Namespace === ns && x.OptionName === name)?.Value || undefined;
const list = (v?: string) => uniq((v ?? "").split(",").map((x) => x.trim()));

// Where the environment runs and what it's sized as, from its configuration settings.
export function beanstalkPlacement(o: OptionSetting[]): {
  vpcId?: string; subnetIds: string[]; securityGroups: string[]; instanceType?: string; instanceProfile?: string; serviceRole?: string; envType?: string;
} {
  return {
    vpcId: opt(o, "aws:ec2:vpc", "VPCId"),
    subnetIds: list(opt(o, "aws:ec2:vpc", "Subnets")),
    securityGroups: list(opt(o, "aws:autoscaling:launchconfiguration", "SecurityGroups")).filter((g) => g.startsWith("sg-")),
    instanceType: list(opt(o, "aws:ec2:instances", "InstanceTypes"))[0] ?? opt(o, "aws:autoscaling:launchconfiguration", "InstanceType"),
    instanceProfile: opt(o, "aws:autoscaling:launchconfiguration", "IamInstanceProfile"),
    serviceRole: opt(o, "aws:elasticbeanstalk:environment", "ServiceRole"),
    envType: opt(o, "aws:elasticbeanstalk:environment", "EnvironmentType"),
  };
}

// The roles an environment runs as: its instances' profile and Beanstalk's own service role (names or ARNs in the settings).
export function beanstalkRoleLinks(envKey: string, o: OptionSetting[], account?: string, region?: string): Link[] {
  const p = beanstalkPlacement(o);
  const out: Link[] = [];
  const profile = profileRef(p.instanceProfile, account, region);
  if (profile) out.push({ from: envKey, to: profile, kind: "assumes", label: "instance profile", evidence: "aws:autoscaling:launchconfiguration IamInstanceProfile" });
  const role = roleRef(p.serviceRole, account, region);
  if (role) out.push({ from: envKey, to: role, kind: "assumes", label: "service role", evidence: "aws:elasticbeanstalk:environment ServiceRole" });
  return out;
}

// Environment properties → mentions (values stay server-side; names label the edge).
export const beanstalkEnvMentions = (from: string, o: OptionSetting[]): Mention[] =>
  envMentions(from, o.filter((x) => x.Namespace === ENV_NS && x.OptionName).map((x) => ({ name: x.OptionName!, value: x.Value })));

export function versionProblem(label: string, versions: { label: string; status?: string }[], current?: string): string | undefined {
  const v = versions.find((x) => x.label === label);
  if (!v) return `no application version "${label.slice(0, 100)}" — pick one of ${versions.slice(0, 5).map((x) => x.label).join(", ") || "(none)"}`;
  if (v.status === "FAILED") return `version ${label} failed to process — upload it again`;
  if (v.status === "PROCESSING" || v.status === "BUILDING") return `version ${label} is still ${v.status.toLowerCase()}`;
  if (label === current) return `${label} is already deployed`;
  return undefined;
}

// ---------- resources ----------

export interface AppRunnerView {
  name: string;
  arn: string;
  status: string;
  url?: string;
  source: { image?: string; imageRepoType?: string; codeRepo?: string; branch?: string; runtime?: string; port?: string };
  autoDeploy?: boolean; // undefined until the service was described
  cpu?: string; // "1024" or "1 vCPU"
  memory?: string; // "2048" or "2 GB"
  instanceRole?: string;
  accessRole?: string; // AuthenticationConfiguration.AccessRoleArn: pulls a private ECR image
  kmsKey?: string; // EncryptionConfiguration.KmsKey
  egress?: string; // DEFAULT | VPC
  vpcConnector?: string; // ARN
  publicIngress?: boolean;
  subnetIds: string[]; // from the VPC connector
  securityGroups: string[];
  tags?: Record<string, string>; // undefined until read
  env: { name: string; value?: string }[];
  createdAt?: number;
  updatedAt?: number;
}

const size = (v: string | undefined, unit: "vCPU" | "GB") => {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? `${+(n / 1024).toFixed(2)} ${unit}` : v;
};
export const apprunnerId = (arn: string) => arn.split("/").pop() ?? "";

// What the service runs as and pulls from: its instance role and ECR access role (assumes), the ECR repository of its
// image (pulls), the VPC connector its egress goes through (uses; a Resource Explorer row) and its KMS key (encrypts).
export function apprunnerLinks(s: AppRunnerView, region: string, account?: string): Link[] {
  const out: Link[] = [];
  const instance = roleRef(s.instanceRole, account, region);
  if (instance) out.push({ from: s.arn, to: instance, kind: "assumes", label: "instance role", evidence: "InstanceConfiguration.InstanceRoleArn" });
  const access = roleRef(s.accessRole, account, region);
  if (access) out.push({ from: s.arn, to: access, kind: "assumes", label: "ECR access role", evidence: "AuthenticationConfiguration.AccessRoleArn" });
  const repo = s.source.imageRepoType === "ECR_PUBLIC" ? undefined : ecrRepoRef(s.source.image);
  if (repo) out.push({ from: s.arn, to: repo, kind: "pulls", label: "image", evidence: `ImageRepository ${s.source.image}` });
  if (s.vpcConnector?.startsWith("arn:")) out.push({ from: s.arn, to: s.vpcConnector, kind: "uses", label: "VPC connector", evidence: "NetworkConfiguration.EgressConfiguration.VpcConnectorArn" });
  const kms = kmsRef(s.kmsKey, region, account);
  if (kms) out.push({ from: kms, to: s.arn, kind: "encrypts", label: "service data", evidence: "EncryptionConfiguration.KmsKey" });
  return out;
}

// `state`: how discovery's per-service reads went (details, tags); absent = not attempted (a checkpointed list).
export function apprunnerResource(s: AppRunnerView, region: string, account?: string, state?: Record<string, EnrichState>): { resource: Resource; mentions: Mention[]; links: Link[] } {
  const h = apprunnerHealth(s.status);
  const src = s.source.image
    ? `image ${s.source.image}${s.source.imageRepoType ? ` (${s.source.imageRepoType})` : ""}`
    : s.source.codeRepo ? `code ${s.source.codeRepo}${s.source.branch ? ` @ ${s.source.branch}` : ""}${s.source.runtime ? ` · ${s.source.runtime}` : ""}` : undefined;
  const resource: Resource = {
    key: s.arn, kind: "apprunner", provider: "apprunner", name: s.name, region, tags: s.tags ?? {}, health: h.health, healthReason: h.healthReason,
    ...(s.tags === undefined ? { tagsUnread: true } : {}), // R01: not read ≠ none
    ...(state ? { enrichment: { ...state } } : {}),
    props: props(
      prop("Status", s.status), prop("URL", s.url ? `https://${s.url}` : undefined, true), prop("Source", src, true),
      prop("Auto deploy", s.autoDeploy === undefined ? undefined : s.autoDeploy ? "on" : "off"),
      prop("Instance", [size(s.cpu, "vCPU"), size(s.memory, "GB")].filter(Boolean).join(" · ")), prop("Port", s.source.port),
      prop("VPC connector", s.vpcConnector?.split("/")[1]),
      // Ingress is known only once the service was described (autoDeploy comes with it); the list alone says nothing.
      prop("Ingress", s.autoDeploy === undefined ? undefined : s.publicIngress === false ? "private (VPC endpoint)" : "public"),
      prop("Instance role", s.instanceRole?.split("/").pop()),
    ),
    subnetIds: s.subnetIds.length ? s.subnetIds : undefined, securityGroups: s.securityGroups.length ? s.securityGroups : undefined,
    endpoints: uniq([s.url]), aliases: [s.name], createdAt: s.createdAt, lastModified: s.updatedAt,
    consoleUrl: `https://${region}.console.aws.amazon.com/apprunner/home?region=${region}#/services/dashboard?service_arn=${encodeURIComponent(s.arn)}`,
  };
  return { resource, mentions: envMentions(s.arn, s.env), links: apprunnerLinks(s, region, account) };
}

export interface BeanstalkView {
  name: string;
  id: string;
  arn: string;
  app: string;
  status: string;
  health?: string;
  healthStatus?: string;
  cause?: string;
  version?: string;
  platform?: string;
  tier?: string; // WebServer | Worker
  cname?: string;
  endpointUrl?: string; // load balancer DNS name, or the instance's Elastic IP
  tags?: Record<string, string>; // undefined until read
  createdAt?: number;
  updatedAt?: number;
  resources: BeanstalkResources;
  options: OptionSetting[];
}

const IP = /^\d{1,3}(\.\d{1,3}){3}$/;
export const isElbHost = (h?: string) => !!h && /\.elb\.amazonaws\.com(\.cn)?$/i.test(h);

// The environment answers on its CNAME. Its endpoint URL is either its load balancer's DNS name or its instance's
// Elastic IP — both belong to other nodes (an endpoint two nodes claim resolves to neither), so the LB name becomes a
// Link from the load balancer plus an alias the inventory falls back to when no load balancer node answers to it.
// `state`: how discovery's per-environment reads went (details, tags); absent = not attempted (a checkpointed list).
export function beanstalkResource(
  e: BeanstalkView, region: string, account?: string, state?: Record<string, EnrichState>, home?: string,
): { resource: Resource; links: Link[]; mentions: Mention[] } {
  const h = beanstalkHealth(e);
  const p = beanstalkPlacement(e.options);
  const links = [...beanstalkLinks(e.arn, e.resources, region, home), ...beanstalkRoleLinks(e.arn, e.options, account, region)];
  if (isElbHost(e.endpointUrl)) links.unshift({ from: e.endpointUrl!, to: e.arn, kind: "route", label: "load balancer", evidence: "Elastic Beanstalk environment endpoint" });
  const resource: Resource = {
    key: e.arn, kind: "beanstalk", provider: "beanstalk", name: e.name, region, tags: e.tags ?? {}, health: h.health, healthReason: h.healthReason,
    ...(e.tags === undefined ? { tagsUnread: true } : {}), // R01: not read ≠ none
    ...(state ? { enrichment: { ...state } } : {}),
    props: props(
      prop("Application", e.app), prop("Environment id", e.id, true), prop("Status", e.status),
      prop("Health", e.health ? `${e.health}${e.healthStatus ? ` (${e.healthStatus})` : ""}` : undefined), prop("Version", e.version), prop("Platform", e.platform),
      prop("Tier", e.tier), prop("Environment type", p.envType), prop("CNAME", e.cname, true),
      prop(isElbHost(e.endpointUrl) ? "Load balancer" : IP.test(e.endpointUrl ?? "") ? "Elastic IP" : "Endpoint URL", e.endpointUrl, true),
      prop("Instance type", p.instanceType), prop("Instance profile", p.instanceProfile), prop("Service role", p.serviceRole?.split("/").pop()),
      prop("Auto Scaling group", e.resources.autoScalingGroups[0], true),
    ),
    vpcId: p.vpcId, subnetIds: p.subnetIds.length ? p.subnetIds : undefined, securityGroups: p.securityGroups.length ? p.securityGroups : undefined,
    endpoints: uniq([e.cname]), aliases: uniq([e.name, e.id, isElbHost(e.endpointUrl) ? e.endpointUrl : undefined]), createdAt: e.createdAt, lastModified: e.updatedAt,
    consoleUrl: `https://${region}.console.aws.amazon.com/elasticbeanstalk/home?region=${region}#/environment/dashboard?environmentId=${encodeURIComponent(e.id)}`,
  };
  return { resource, links, mentions: beanstalkEnvMentions(e.arn, e.options) };
}
