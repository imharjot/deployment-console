// ARNs, pure: parse one into its parts and its Resource Explorer type, name it, strip what makes two ARNs of one
// resource differ (a log group's ":*", a Lambda qualifier, a secret's JSON key / stage / version), and build the
// canonical key of every coverage kind (arnOf), so every provider and package produces identical keys (CC-13).
//
// Type rules (audit §6 B.2, CC-8), in Resource Explorer spelling:
// - No type segment: s3 ("bucket"; a key under it folds to the bucket), sqs ("queue"), sns ("topic"; a further ":" is a
//   subscription), codepipeline ("pipeline") and codecommit ("repository") — the name is never taken for a type.
// - Sub-types: elasticloadbalancing "loadbalancer/app|net|gwy", "listener/…", "listener-rule/…"; apigateway
//   "/restapis/<id>/stages/<s>" → "restapis/stages" (collections alternate with ids, as in amplify, globalaccelerator,
//   vpc-lattice, kendra and bedrock flows); lambda "function:<n>:<qualifier>" → "function/version"; wafv2
//   "<scope>/webacl/<name>/<id>" → "webacl".
// - Otherwise: split at the first "/" when it comes before any ":", else at the first ":".
// A type Resource Explorer reports (ListResources' ResourceType) wins over this; arnType is for ARNs from elsewhere.

export interface ParsedArn {
  partition: string; // "aws", "aws-cn", "aws-us-gov"
  service: string; // "elasticloadbalancing"
  region: string; // "" for global services (IAM, S3 buckets, Route 53, CloudFront)
  account: string; // "" for S3 buckets and Route 53
  resource: string; // everything after the account: "loadbalancer/app/acme-production/5f2c1a9d3e7b4c60"
  type: string; // Resource Explorer type without the service: "loadbalancer/app"
  id: string; // the rest after the type: "acme-production/5f2c1a9d3e7b4c60"
}

const ARN = /^arn:(aws[a-z-]*):([a-z0-9-]+):([a-z0-9-]*):(\d{12}|aws|)?:(.+)$/;
// Services whose resource path alternates collection / id / collection / id…
const ALTERNATING = new Set(["apigateway", "amplify", "globalaccelerator", "vpc-lattice", "kendra", "emr-containers", "iottwinmaker", "appconfig", "refactor-spaces", "dataexchange", "connect", "mobiletargeting", "profile", "chime"]);

function alternating(resource: string): { type: string; id: string } {
  const segs = resource.replace(/^\/+/, "").split("/");
  const types: string[] = [], ids: string[] = [];
  segs.forEach((x, i) => (i % 2 ? ids : types).push(x));
  return { type: types.join("/"), id: ids.join("/") };
}

function split(resource: string): { type: string; id: string } {
  const slash = resource.indexOf("/"), colon = resource.indexOf(":");
  if (slash >= 0 && (colon < 0 || slash < colon)) return { type: resource.slice(0, slash), id: resource.slice(slash + 1) };
  if (colon >= 0) return { type: resource.slice(0, colon), id: resource.slice(colon + 1) };
  return { type: resource, id: "" };
}

function typeOf(service: string, resource: string): { type: string; id: string } {
  switch (service) {
    case "s3":
      if (resource.startsWith("accesspoint/") || resource.startsWith("storage-lens/") || resource.startsWith("job/")) return split(resource);
      return { type: "bucket", id: resource.split("/")[0] };
    case "sqs":
      return { type: "queue", id: resource };
    case "sns":
      return resource.includes(":") ? { type: "subscription", id: resource } : { type: "topic", id: resource };
    case "codepipeline":
      return resource.startsWith("webhook:") ? split(resource) : { type: "pipeline", id: resource };
    case "codecommit":
      return { type: "repository", id: resource };
    case "elasticloadbalancing": {
      const m = /^(loadbalancer|listener|listener-rule)\/(app|net|gwy)\/(.+)$/.exec(resource);
      return m ? { type: `${m[1]}/${m[2]}`, id: m[3] } : split(resource);
    }
    case "lambda": {
      const [t, name, qualifier] = resource.split(":");
      if ((t === "function" || t === "layer") && qualifier) return { type: `${t}/version`, id: `${name}:${qualifier}` };
      return split(resource);
    }
    case "wafv2": {
      const m = /^(regional|global)\/([a-z-]+)\/(.+)$/.exec(resource);
      return m ? { type: m[2], id: m[3] } : split(resource);
    }
    case "logs": {
      const m = /^log-group:([^:]+)(?::log-stream:(.+))?(?::\*)?$/.exec(resource);
      if (m) return m[2] !== undefined ? { type: "log-stream", id: `${m[1]}/${m[2]}` } : { type: "log-group", id: m[1] };
      return split(resource);
    }
    case "bedrock":
      return resource.startsWith("flow/") ? alternating(resource) : split(resource);
    default:
      return ALTERNATING.has(service) ? alternating(resource) : split(resource);
  }
}

export function parseArn(arn: string): ParsedArn | undefined {
  const m = ARN.exec(String(arn ?? "").trim());
  if (!m) return undefined;
  const [, partition, service, region, account = "", resource] = m;
  const { type, id } = typeOf(service, resource);
  return { partition, service, region, account, resource, type, id };
}

// "elasticloadbalancing:loadbalancer/app", "s3:bucket", "lambda:function/version" — as Resource Explorer spells it.
export const arnType = (p: ParsedArn): string => `${p.service}:${p.type}`;

const lastSegment = (s: string) => s.split("/").filter(Boolean).pop() ?? s;

// What people call it. The Name tag wins; otherwise per service (B.2).
export function arnName(p: ParsedArn, tags?: Record<string, string>): string {
  const tagged = tags && Object.hasOwn(tags, "Name") ? tags.Name?.trim() : undefined;
  if (tagged) return tagged;
  const { service, type, id } = p;
  if (service === "elasticloadbalancing" && /^(loadbalancer|targetgroup)/.test(type)) return id.split("/")[0] || id; // "<name>/<hash>"
  if (service === "ecs" && type === "service") return lastSegment(id); // "service/<cluster>/<name>" (or the old "service/<name>")
  if (service === "cloudformation" && (type === "stack" || type === "stackset")) return id.split("/")[0] || id;
  if (service === "codedeploy" && type === "deploymentgroup") return id.split("/").pop() ?? id;
  if (service === "ssm" && type === "parameter") return `/${id}`;
  if (service === "iam") return lastSegment(id);
  if (service === "kafka" && type === "cluster") return id.split("/")[0] || id;
  if (service === "wafv2") return id.split("/")[0] || id;
  if (service === "mq" && type === "broker") return id.split(":")[0] || id;
  if (service === "autoscaling") return /autoScalingGroupName\/(.+)$/.exec(id)?.[1] ?? /policyName\/(.+)$/.exec(id)?.[1] ?? id;
  if (service === "events" && type === "rule") return lastSegment(id); // "rule/<bus>/<name>" or "rule/<name>"
  if (service === "apigateway" || ALTERNATING.has(service)) return lastSegment(id) || id;
  return id || type; // id-only ARNs (ec2:*, redshift-serverless) and names: the id itself; a secret keeps its suffix
}

// The part two references to one resource share: a log group without ":*", a function without its qualifier, a secret
// without the JSON key / version stage / version id an ECS valueFrom appends. Anything else is returned unchanged.
export function arnBase(arn: string): string {
  const p = arn.split(":");
  if (p[0] !== "arn" || p.length < 6) return arn;
  if (p[2] === "logs" && p[5] === "log-group" && p[p.length - 1] === "*") return p.slice(0, -1).join(":");
  if (p[2] === "lambda" && p[5] === "function" && p.length > 7) return p.slice(0, 7).join(":");
  if (p[2] === "secretsmanager" && p[5] === "secret" && p.length > 7) return p.slice(0, 7).join(":");
  return arn;
}

// The partition a region lives in (keys built from a region need the right one).
const PARTITIONS: [string, string][] = [
  ["cn-", "aws-cn"], ["us-gov-", "aws-us-gov"], ["us-iso-", "aws-iso"], ["us-isob-", "aws-iso-b"], ["eu-isoe-", "aws-iso-e"],
  ["us-isof-", "aws-iso-f"], ["eusc-", "aws-eusc"],
];
export const partitionOf = (region: string): string => PARTITIONS.find(([prefix]) => region.startsWith(prefix))?.[1] ?? "aws";
const build = (service: string, region: string, account: string, resource: string) => `arn:${partitionOf(region)}:${service}:${region}:${account}:${resource}`;
const buildGlobal = (service: string, account: string, resource: string, partition = "aws") => `arn:${partition}:${service}::${account}:${resource}`;
const noSlash = (s: string) => s.replace(/^\/+/, "");
// IAM paths start and end with "/" ("/", "/service-role/", "/aws-service-role/ecs.amazonaws.com/").
const iamPath = (p: string) => `/${p.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");

// Canonical keys. Regional builders take (region, account, …ids); global ones (IAM, Global Accelerator, Route 53) take
// what their ARN has, plus the partition outside the commercial one (partitionOf(home)). Keys are what AWS returns as the resource's ARN, so a key built here and an ARN read from an API
// (or listed by Resource Explorer) are the same string.
export const arnOf = {
  // network
  vpc: (r: string, a: string, id: string) => build("ec2", r, a, `vpc/${id}`),
  subnet: (r: string, a: string, id: string) => build("ec2", r, a, `subnet/${id}`),
  natGateway: (r: string, a: string, id: string) => build("ec2", r, a, `natgateway/${id}`),
  internetGateway: (r: string, a: string, id: string) => build("ec2", r, a, `internet-gateway/${id}`),
  egressOnlyInternetGateway: (r: string, a: string, id: string) => build("ec2", r, a, `egress-only-internet-gateway/${id}`),
  vpcEndpoint: (r: string, a: string, id: string) => build("ec2", r, a, `vpc-endpoint/${id}`),
  vpcPeering: (r: string, a: string, id: string) => build("ec2", r, a, `vpc-peering-connection/${id}`),
  transitGatewayAttachment: (r: string, a: string, id: string) => build("ec2", r, a, `transit-gateway-attachment/${id}`),
  eip: (r: string, a: string, allocationId: string) => build("ec2", r, a, `elastic-ip/${allocationId}`),
  vpnConnection: (r: string, a: string, id: string) => build("ec2", r, a, `vpn-connection/${id}`),
  routeTable: (r: string, a: string, id: string) => build("ec2", r, a, `route-table/${id}`),
  networkAcl: (r: string, a: string, id: string) => build("ec2", r, a, `network-acl/${id}`),
  securityGroup: (r: string, a: string, id: string) => build("ec2", r, a, `security-group/${id}`),
  ec2Instance: (r: string, a: string, id: string) => build("ec2", r, a, `instance/${id}`),
  ebsVolume: (r: string, a: string, id: string) => build("ec2", r, a, `volume/${id}`),
  cloudMapNamespace: (r: string, a: string, id: string) => build("servicediscovery", r, a, `namespace/${id}`),
  cloudMapService: (r: string, a: string, id: string) => build("servicediscovery", r, a, `service/${id}`),
  networkFirewall: (r: string, a: string, name: string) => build("network-firewall", r, a, `firewall/${name}`),
  resolverEndpoint: (r: string, a: string, id: string) => build("route53resolver", r, a, `resolver-endpoint/${id}`),
  resolverRule: (r: string, a: string, id: string) => build("route53resolver", r, a, `resolver-rule/${id}`),
  latticeServiceNetwork: (r: string, a: string, id: string) => build("vpc-lattice", r, a, `servicenetwork/${id}`),
  latticeService: (r: string, a: string, id: string) => build("vpc-lattice", r, a, `service/${id}`),
  // security
  iamRole: (a: string, name: string, path = "/", partition = "aws") => buildGlobal("iam", a, `role${iamPath(path)}${name}`, partition), // path "/service-role/"
  iamInstanceProfile: (a: string, name: string, path = "/", partition = "aws") => buildGlobal("iam", a, `instance-profile${iamPath(path)}${name}`, partition),
  kmsKey: (r: string, a: string, keyId: string) => build("kms", r, a, `key/${keyId}`),
  kmsAlias: (r: string, a: string, alias: string) => build("kms", r, a, alias.startsWith("alias/") ? alias : `alias/${alias}`),
  acmCertificate: (r: string, a: string, id: string) => build("acm", r, a, `certificate/${id}`),
  secretPartial: (r: string, a: string, name: string) => build("secretsmanager", r, a, `secret:${name}`), // without the random suffix
  ssmParameter: (r: string, a: string, name: string) => build("ssm", r, a, `parameter/${noSlash(name)}`),
  wafAcl: (r: string, a: string, scope: "regional" | "global", name: string, id: string) => build("wafv2", r, a, `${scope}/webacl/${name}/${id}`),
  cognitoUserPool: (r: string, a: string, id: string) => build("cognito-idp", r, a, `userpool/${id}`),
  backupPlan: (r: string, a: string, id: string) => build("backup", r, a, `backup-plan:${id}`),
  backupVault: (r: string, a: string, name: string) => build("backup", r, a, `backup-vault:${name}`),
  // observability
  logGroup: (r: string, a: string, name: string) => build("logs", r, a, `log-group:${name}`), // logGroupArn: no ":*"
  cloudwatchAlarm: (r: string, a: string, name: string) => build("cloudwatch", r, a, `alarm:${name}`),
  syntheticsCanary: (r: string, a: string, name: string) => build("synthetics", r, a, `canary:${name}`),
  healthCheck: (id: string, partition = "aws") => `arn:${partition}:route53:::healthcheck/${id}`,
  cloudtrailTrail: (r: string, a: string, name: string) => build("cloudtrail", r, a, `trail/${name}`),
  // delivery
  ecrRepository: (r: string, a: string, name: string) => build("ecr", r, a, `repository/${name}`),
  pipeline: (r: string, a: string, name: string) => build("codepipeline", r, a, name),
  codebuildProject: (r: string, a: string, name: string) => build("codebuild", r, a, `project/${name}`),
  codedeployGroup: (r: string, a: string, app: string, group: string) => build("codedeploy", r, a, `deploymentgroup:${app}/${group}`),
  // the stack id's trailing UUID, not the whole StackId (DescribeStacks' StackId already is this ARN: use it as the key)
  cfnStack: (r: string, a: string, name: string, uuid: string) => build("cloudformation", r, a, `stack/${name}/${uuid}`),
  // data
  rdsDb: (r: string, a: string, id: string) => build("rds", r, a, `db:${id}`),
  rdsCluster: (r: string, a: string, id: string) => build("rds", r, a, `cluster:${id}`), // also DocumentDB and Neptune clusters
  rdsProxy: (r: string, a: string, proxyResourceId: string) => build("rds", r, a, `db-proxy:${proxyResourceId}`), // "prx-…"
  elasticacheRg: (r: string, a: string, id: string) => build("elasticache", r, a, `replicationgroup:${id}`),
  elasticacheCluster: (r: string, a: string, id: string) => build("elasticache", r, a, `cluster:${id}`),
  elasticacheServerless: (r: string, a: string, name: string) => build("elasticache", r, a, `serverlesscache:${name}`),
  memorydbCluster: (r: string, a: string, name: string) => build("memorydb", r, a, `cluster/${name}`),
  opensearchDomain: (r: string, a: string, name: string) => build("es", r, a, `domain/${name}`),
  redshiftCluster: (r: string, a: string, id: string) => build("redshift", r, a, `cluster:${id}`),
  redshiftWorkgroup: (r: string, a: string, workgroupId: string) => build("redshift-serverless", r, a, `workgroup/${workgroupId}`),
  glueJob: (r: string, a: string, name: string) => build("glue", r, a, `job/${name}`),
  glueCrawler: (r: string, a: string, name: string) => build("glue", r, a, `crawler/${name}`),
  athenaWorkgroup: (r: string, a: string, name: string) => build("athena", r, a, `workgroup/${name}`),
  // storage
  efs: (r: string, a: string, id: string) => build("elasticfilesystem", r, a, `file-system/${id}`),
  efsAccessPoint: (r: string, a: string, id: string) => build("elasticfilesystem", r, a, `access-point/${id}`),
  fsx: (r: string, a: string, id: string) => build("fsx", r, a, `file-system/${id}`),
  // messaging
  mskCluster: (r: string, a: string, name: string, uuid: string) => build("kafka", r, a, `cluster/${name}/${uuid}`),
  mqBroker: (r: string, a: string, name: string, id: string) => build("mq", r, a, `broker:${name}:${id}`),
  firehose: (r: string, a: string, name: string) => build("firehose", r, a, `deliverystream/${name}`),
  schedule: (r: string, a: string, group: string, name: string) => build("scheduler", r, a, `schedule/${group}/${name}`),
  pipe: (r: string, a: string, name: string) => build("pipes", r, a, `pipe/${name}`),
  sesIdentity: (r: string, a: string, identity: string) => build("ses", r, a, `identity/${identity}`),
  // edge
  globalAccelerator: (a: string, id: string) => buildGlobal("globalaccelerator", a, `accelerator/${id}`),
  classicElb: (r: string, a: string, name: string) => build("elasticloadbalancing", r, a, `loadbalancer/${name}`),
  transferServer: (r: string, a: string, id: string) => build("transfer", r, a, `server/${id}`),
  appsyncApi: (r: string, a: string, id: string) => build("appsync", r, a, `apis/${id}`),
  // compute
  amplifyApp: (r: string, a: string, id: string) => build("amplify", r, a, `apps/${id}`),
  lightsailInstance: (r: string, a: string, id: string) => build("lightsail", r, a, `Instance/${id}`),
  lightsailContainer: (r: string, a: string, id: string) => build("lightsail", r, a, `ContainerService/${id}`),
  lightsailDatabase: (r: string, a: string, id: string) => build("lightsail", r, a, `RelationalDatabase/${id}`),
  batchEnvironment: (r: string, a: string, name: string) => build("batch", r, a, `compute-environment/${name}`),
  batchQueue: (r: string, a: string, name: string) => build("batch", r, a, `job-queue/${name}`),
  sagemakerEndpoint: (r: string, a: string, name: string) => build("sagemaker", r, a, `endpoint/${name.toLowerCase()}`), // SageMaker lower-cases names in ARNs
  sagemakerNotebook: (r: string, a: string, name: string) => build("sagemaker", r, a, `notebook-instance/${name.toLowerCase()}`),
  bedrockAgent: (r: string, a: string, id: string) => build("bedrock", r, a, `agent/${id}`),
  bedrockKnowledgeBase: (r: string, a: string, id: string) => build("bedrock", r, a, `knowledge-base/${id}`),
  bedrockProvisionedModel: (r: string, a: string, id: string) => build("bedrock", r, a, `provisioned-model/${id}`),
  ecsService: (r: string, a: string, cluster: string, service: string) => build("ecs", r, a, `service/${cluster}/${service}`),
};
