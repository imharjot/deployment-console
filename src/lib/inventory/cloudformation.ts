// CloudFormation stacks, pure part (audit §6 A.2 #22): DescribeStacks (+ ListStackResources for the first stacks within
// the time budget), real or simulated → Resources and `manages` links. No AWS calls and no `server-only`, so node:test
// runs it (cloudformation.test.ts).
// - Key: the StackId (it already is the stack's ARN, with its UUID). A nested stack's parent is its ParentId.
// - Health: ROLLBACK_COMPLETE error ("creation failed"); UPDATE_ROLLBACK_COMPLETE / IMPORT_ROLLBACK_COMPLETE warning;
//   *_FAILED error; *_IN_PROGRESS ok, or a warning after an hour; REVIEW_IN_PROGRESS stopped (a change set nobody ran);
//   DRIFTED warning.
// - `manages` edges: what CloudFormation tags itself (aws:cloudformation:stack-id) is turned into edges by the inventory
//   rules for free; ListStackResources adds what can't be tagged, through the type → reference table below.
// - Secrets: parameters show keys only (values may be passwords; NoEcho ones come back masked anyway). An output value
//   is shown only when it is an ARN, a URL (no credentials, query or token-like path segments), a hostname or an AWS
//   resource id; anything else shows as hidden. Templates (GetTemplate) and resource properties are never read.
import { arnOf, partitionOf } from "./arn.ts";
import { roleRef } from "./compute-common.ts";
import { awsTime, clip, fmtTime, props, queueArnFromUrl, tagsOf } from "./serverless-common.ts";
import { keys, type EnrichState, type Health, type Link, type ProviderResult, type Resource, type ResourceDetail } from "./types.ts";

type When = Date | string | number;
export interface RawStack {
  StackId?: string;
  StackName?: string;
  StackStatus?: string;
  StackStatusReason?: string;
  Description?: string;
  CreationTime?: When;
  LastUpdatedTime?: When;
  Parameters?: { ParameterKey?: string; ParameterValue?: string; ResolvedValue?: string }[];
  Outputs?: { OutputKey?: string; OutputValue?: string; Description?: string; ExportName?: string }[];
  Tags?: { Key?: string; Value?: string }[];
  RoleARN?: string;
  ParentId?: string;
  RootId?: string;
  EnableTerminationProtection?: boolean;
  DriftInformation?: { StackDriftStatus?: string; LastCheckTimestamp?: When };
  NotificationARNs?: string[];
}
export interface RawStackResource { LogicalResourceId?: string; PhysicalResourceId?: string; ResourceType?: string; ResourceStatus?: string; ResourceStatusReason?: string; LastUpdatedTimestamp?: When }
export interface RawStackEvent { Timestamp?: When; LogicalResourceId?: string; ResourceType?: string; ResourceStatus?: string; ResourceStatusReason?: string }
export interface Read<T> { value?: T; state: EnrichState }
export interface CfnRaw { stacks: RawStack[]; resources?: Record<string, Read<RawStackResource[]>> }
export interface CfnOptions { region: string; accountId?: string; home?: string; now?: number }

const HOUR = 3_600_000;
const lower = (s: string) => s.toLowerCase().replace(/_/g, " ");

export function stackHealth(s: Pick<RawStack, "StackStatus" | "StackStatusReason" | "LastUpdatedTime" | "CreationTime" | "DriftInformation">, now: number): { health: Health; reason?: string } {
  const st = s.StackStatus ?? "";
  const why = s.StackStatusReason ? `: ${clip(s.StackStatusReason, 160)}` : "";
  if (st === "REVIEW_IN_PROGRESS") return { health: "stopped", reason: "review in progress — a change set that was never executed" };
  if (st === "ROLLBACK_COMPLETE") return { health: "error", reason: `creation failed and was rolled back${why} — it can only be deleted` };
  if (st.endsWith("_FAILED")) return { health: "error", reason: `${lower(st)}${why}` };
  if (st === "UPDATE_ROLLBACK_COMPLETE") return { health: "warning", reason: "the last update failed and was rolled back" };
  if (st === "IMPORT_ROLLBACK_COMPLETE") return { health: "warning", reason: "the last import failed and was rolled back" };
  if (st.endsWith("_IN_PROGRESS")) {
    // A rollback under way already means the change failed (creation → ROLLBACK_COMPLETE, an update → back to before).
    if (/ROLLBACK_(COMPLETE_CLEANUP_)?IN_PROGRESS$/.test(st)) return { health: "warning", reason: `${lower(st)}${why || " — the last change failed"}` };
    const since = awsTime(s.LastUpdatedTime) ?? awsTime(s.CreationTime);
    return since !== undefined && now - since > HOUR ? { health: "warning", reason: `${lower(st)} for more than an hour` } : { health: "ok", reason: lower(st) };
  }
  if (s.DriftInformation?.StackDriftStatus === "DRIFTED") return { health: "warning", reason: "drifted — resources were changed outside CloudFormation" };
  if (/_COMPLETE$/.test(st)) return { health: "ok" };
  return { health: "unknown", ...(st ? { reason: lower(st) } : {}) };
}

// AWS resource ids an output may show ("vpc-0a1b…", "sg-…", "subnet-…"): a known prefix and one lower-case run.
const AWS_ID = /^(vpc|subnet|sg|i|igw|eigw|nat|rtb|acl|eni|vol|snap|ami|eipalloc|vpce|pcx|tgw|tgw-attach|lt|fs|fsap|prx|srv|ns|pl|vgw|cgw|vpn|dopt|cluster|db)-[0-9a-z]{3,32}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;
// A path segment that looks like a token (Slack webhook ids, signed parts): long and mixing letters and digits.
const TOKENISH = (seg: string) => seg.length >= 16 && /[a-z]/i.test(seg) && /\d/.test(seg);

// An output value people may see, or undefined when it may be anything else (a password, a key, a connection string).
export function safeOutput(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || v.length > 2048 || /\s/.test(v)) return undefined;
  if (/^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[\w./:@+=,*-]+$/.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!u.hostname) return undefined;
      const path = u.pathname.split("/").map((s) => (TOKENISH(decodeURIComponent(s)) ? "…" : s)).join("/");
      return `${u.protocol}//${u.host}${path === "/" ? "" : path}`;
    } catch {
      return undefined;
    }
  }
  // A two-label name in mixed case ("Summer2026.Rocks") is as likely a password as a host: DNS names an output carries
// are lower case or longer (<db>.<id>.<region>.rds.amazonaws.com, internal-Api-1.us-east-1.elb.amazonaws.com).
  if (HOST.test(v) && /[a-z]/i.test(v.split(".").pop() ?? "") && (v === v.toLowerCase() || v.replace(/\.$/, "").split(".").length > 2)) return v.toLowerCase();
  if (AWS_ID.test(v)) return v;
  return undefined;
}

// A stack resource (type + physical id) → the key or reference of the node it is, for the types the map draws.
// undefined for everything else (sub-objects, policies, types the map has no node for).
export function stackResourceRef(type: string | undefined, physical: string | undefined, o: CfnOptions & { account?: string }): string | undefined {
  const id = physical?.trim();
  if (!type || !id) return undefined;
  const r = o.region;
  const a = o.account ?? o.accountId ?? "";
  const p = partitionOf(r);
  const home = o.home ?? r;
  const build = (svc: string, rest: string) => (a ? `arn:${p}:${svc}:${r}:${a}:${rest}` : undefined);
  switch (type) {
    case "AWS::ECS::Service": {
      const m = /:service\/([^/]+)\/([^/]+)$/.exec(id);
      return m ? keys.ecsService(m[1], m[2], r, home) : undefined;
    }
    case "AWS::ElasticLoadBalancingV2::LoadBalancer": {
      const m = /:loadbalancer\/(?:app|net|gwy)\/([^/]+)\//.exec(id);
      return m ? keys.loadBalancer(m[1], r, home) : undefined;
    }
    case "AWS::ElasticLoadBalancing::LoadBalancer":
      return a ? arnOf.classicElb(r, a, id) : undefined;
    case "AWS::RDS::DBInstance":
      return keys.rds(id, r, home);
    case "AWS::RDS::DBCluster":
      return a ? arnOf.rdsCluster(r, a, id) : undefined;
    case "AWS::ElastiCache::ReplicationGroup":
    case "AWS::ElastiCache::CacheCluster":
      return keys.elasticache(id, r, home);
    case "AWS::EC2::Instance":
      return keys.ec2(id, r, home);
    case "AWS::EC2::VPC":
      return a ? arnOf.vpc(r, a, id) : undefined;
    case "AWS::EC2::Subnet":
      return a ? arnOf.subnet(r, a, id) : undefined;
    case "AWS::EC2::SecurityGroup":
      return a && id.startsWith("sg-") ? arnOf.securityGroup(r, a, id) : undefined;
    case "AWS::EC2::NatGateway":
      return a ? arnOf.natGateway(r, a, id) : undefined;
    case "AWS::EC2::InternetGateway":
      return a ? arnOf.internetGateway(r, a, id) : undefined;
    case "AWS::EC2::VPCEndpoint":
      return a ? arnOf.vpcEndpoint(r, a, id) : undefined;
    case "AWS::EC2::Volume":
      return a ? arnOf.ebsVolume(r, a, id) : undefined;
    case "AWS::SQS::Queue":
      return queueArnFromUrl(id) ?? (id.startsWith("arn:") ? id : undefined);
    case "AWS::SNS::Topic":
    case "AWS::StepFunctions::StateMachine":
    case "AWS::SecretsManager::Secret":
    case "AWS::CertificateManager::Certificate":
    case "AWS::CloudFormation::Stack":
      return id.startsWith("arn:") ? id : undefined;
    case "AWS::S3::Bucket":
      return `arn:${p}:s3:::${id}`;
    case "AWS::DynamoDB::Table":
      return build("dynamodb", `table/${id}`);
    case "AWS::Lambda::Function":
      return id.startsWith("arn:") ? id : build("lambda", `function:${id}`);
    case "AWS::Kinesis::Stream":
      return build("kinesis", `stream/${id}`);
    case "AWS::Events::Rule": {
      if (id.startsWith("arn:")) return id;
      const [bus, name] = id.includes("|") ? id.split("|") : [undefined, id];
      return build("events", bus && bus !== "default" ? `rule/${bus}/${name}` : `rule/${name}`);
    }
    case "AWS::ApiGateway::RestApi":
      return `arn:${p}:apigateway:${r}::/restapis/${id}`;
    case "AWS::ApiGatewayV2::Api":
      return `arn:${p}:apigateway:${r}::/apis/${id}`;
    case "AWS::CloudFront::Distribution":
      return a ? `arn:${p}:cloudfront::${a}:distribution/${id}` : undefined;
    case "AWS::IAM::Role":
      return roleRef(id, a || undefined, r);
    case "AWS::KMS::Key":
      return a ? arnOf.kmsKey(r, a, id) : undefined;
    case "AWS::Logs::LogGroup":
      return a ? arnOf.logGroup(r, a, id) : undefined;
    case "AWS::ECR::Repository":
      return a ? arnOf.ecrRepository(r, a, id) : undefined;
    case "AWS::SSM::Parameter":
      return a ? arnOf.ssmParameter(r, a, id) : undefined;
    case "AWS::ServiceDiscovery::Service":
      return a ? arnOf.cloudMapService(r, a, id) : undefined;
    case "AWS::ServiceDiscovery::PrivateDnsNamespace":
    case "AWS::ServiceDiscovery::PublicDnsNamespace":
    case "AWS::ServiceDiscovery::HttpNamespace":
      return a ? arnOf.cloudMapNamespace(r, a, id) : undefined;
    case "AWS::EFS::FileSystem":
      return a ? arnOf.efs(r, a, id) : undefined;
    case "AWS::CodeBuild::Project":
      return a ? arnOf.codebuildProject(r, a, id) : undefined;
    case "AWS::CodePipeline::Pipeline":
      return a ? arnOf.pipeline(r, a, id) : undefined;
    case "AWS::CloudWatch::Alarm":
      return a ? arnOf.cloudwatchAlarm(r, a, id) : undefined;
    case "AWS::Cognito::UserPool":
      return a ? arnOf.cognitoUserPool(r, a, id) : undefined;
    case "AWS::AutoScaling::AutoScalingGroup":
      return id; // the group's name (its ARN carries a UUID): resolved through the group's aliases
    default:
      return undefined;
  }
}

export const cfnConsoleUrl = (region: string, stackId: string) =>
  `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?stackId=${encodeURIComponent(stackId)}`;

export function cfnResults(raw: CfnRaw, o: CfnOptions): ProviderResult {
  const now = o.now ?? Date.now();
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const s of raw.stacks) {
    if (!s.StackId || !s.StackName || s.StackStatus === "DELETE_COMPLETE") continue;
    const key = s.StackId;
    const region = key.split(":")[3] || o.region;
    const account = key.split(":")[4] || o.accountId;
    const { health, reason } = stackHealth(s, now);
    const params = (s.Parameters ?? []).map((x) => x.ParameterKey).filter((x): x is string => !!x);
    const outputs = (s.Outputs ?? []).filter((x) => x.OutputKey);
    const res = raw.resources?.[key];
    const created = awsTime(s.CreationTime);
    const updated = awsTime(s.LastUpdatedTime);
    resources.push({
      key, kind: "cfn-stack", provider: "cloudformation", name: s.StackName, region,
      ...tagsOf(s.Tags ?? []), // DescribeStacks returns the tags: always read
      health, ...(reason ? { healthReason: reason } : {}),
      ...(s.ParentId ? { parent: s.ParentId } : {}),
      ...(res && res.state !== "ok" ? { enrichment: { resources: res.state } } : {}),
      props: props([
        { label: "Status", value: s.StackStatus ? lower(s.StackStatus) : undefined },
        { label: "Reason", value: s.StackStatusReason && health !== "ok" ? clip(s.StackStatusReason, 200) : undefined },
        { label: "Description", value: s.Description ? clip(s.Description, 200) : undefined },
        { label: "Drift", value: s.DriftInformation?.StackDriftStatus && s.DriftInformation.StackDriftStatus !== "NOT_CHECKED" ? `${lower(s.DriftInformation.StackDriftStatus)}${s.DriftInformation.LastCheckTimestamp ? ` (checked ${fmtTime(awsTime(s.DriftInformation.LastCheckTimestamp))})` : ""}` : undefined },
        { label: "Resources", value: res?.state === "ok" && res.value ? String(res.value.length) : undefined },
        { label: "Parameters", value: params.length ? clip(params.join(", "), 200) : undefined },
        ...outputs.slice(0, 10).map((x) => ({ label: `Output ${x.OutputKey}`, value: safeOutput(x.OutputValue) ?? "(hidden: not a resource reference)", mono: true })),
        { label: "Nested in", value: s.ParentId ? s.ParentId.split("/")[1] : undefined },
        { label: "Termination protection", value: s.EnableTerminationProtection ? "on" : undefined },
        { label: "Created", value: created !== undefined ? fmtTime(created) : undefined },
        { label: "Last updated", value: updated !== undefined ? fmtTime(updated) : undefined },
      ]),
      aliases: [s.StackName],
      consoleUrl: cfnConsoleUrl(region, key),
      ...(created !== undefined ? { createdAt: created } : {}), ...(updated !== undefined ? { lastModified: updated } : {}), ...(o.now ? { observedAt: o.now } : {}),
    });
    if (s.RoleARN) links.push({ from: key, to: s.RoleARN, kind: "assumes", label: "service role", evidence: "stack RoleARN" });
    for (const topic of s.NotificationARNs ?? []) links.push({ from: key, to: topic, kind: "event", label: "stack events", evidence: "stack NotificationARNs" });
    const seen = new Set<string>();
    for (const x of res?.value ?? []) {
      if (x.ResourceStatus === "DELETE_COMPLETE") continue;
      const to = stackResourceRef(x.ResourceType, x.PhysicalResourceId, { ...o, region, account });
      if (!to || to === key || seen.has(to)) continue;
      seen.add(to);
      links.push({ from: key, to, kind: "manages", label: x.LogicalResourceId, evidence: `stack resource ${x.LogicalResourceId} (${x.ResourceType})` });
    }
  }
  return { resources, links, mentions: [] };
}

// Physical ids shown in the panel, except access key ids (not secret, but nobody needs them on a map).
const MASKED = new Set(["AWS::IAM::AccessKey"]);

// The panel: outputs (safe values only), parameter keys, resources and recent events (never resource properties).
export function cfnDetail(key: string, s: RawStack | undefined, resources?: RawStackResource[], events?: RawStackEvent[]): ResourceDetail {
  if (!s) return { key, sections: [{ title: "Stack", note: "The stack couldn't be read (it may have been deleted)." }] };
  const outputs = (s.Outputs ?? []).filter((x) => x.OutputKey);
  return {
    key,
    sections: [
      {
        title: "Stack",
        rows: props([
          { label: "Status", value: s.StackStatus ? lower(s.StackStatus) : undefined },
          { label: "Reason", value: s.StackStatusReason ? clip(s.StackStatusReason, 300) : undefined },
          { label: "Role", value: s.RoleARN, mono: true },
          { label: "Parameters", value: (s.Parameters ?? []).map((x) => x.ParameterKey).filter(Boolean).join(", ") || "none" },
          { label: "Root stack", value: s.RootId && s.RootId !== s.StackId ? s.RootId.split("/")[1] : undefined },
        ]),
        note: "Parameter values and the template are never read: they may hold secrets.",
      },
      ...(outputs.length
        ? [{ title: "Outputs", table: { columns: ["Output", "Value", "Export"], rows: outputs.map((x) => [x.OutputKey!, safeOutput(x.OutputValue) ?? "(hidden)", x.ExportName ?? ""]) } }]
        : []),
      ...(resources
        ? [{
            title: `Resources (${resources.length})`,
            table: { columns: ["Logical id", "Type", "Status", "Physical id"], rows: resources.slice(0, 200).map((x) => [x.LogicalResourceId ?? "", x.ResourceType ?? "", lower(x.ResourceStatus ?? ""), MASKED.has(x.ResourceType ?? "") ? "—" : clip(x.PhysicalResourceId ?? "", 120)]) },
          }]
        : []),
      ...(events?.length
        ? [{ title: "Recent events", table: { columns: ["Time", "Resource", "Status", "Reason"], rows: events.slice(0, 25).map((e) => [fmtTime(awsTime(e.Timestamp)), e.LogicalResourceId ?? "", lower(e.ResourceStatus ?? ""), clip(e.ResourceStatusReason ?? "", 160)]) } }]
        : []),
    ],
  };
}
