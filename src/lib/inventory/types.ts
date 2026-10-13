// The cloud map's data model: every resource the console knows about, whatever AWS service (or Cloudflare) it comes
// from, and the edges between them. Pure types, shared by the server (providers → inventory) and the UI.
//
// Flow: each provider (src/lib/server/providers/*) lists one service's resources and the relationships it can read
// straight from AWS configuration (Links), plus strings that merely *mention* other resources (Mentions — e.g. an
// env var holding a queue URL). The inventory (src/lib/server/inventory.ts) merges everything, resolves mentions
// against every resource's ARN / name / endpoints, assigns environments, marks idle resources, and serves one graph.
import { infoOf } from "./aws-services.ts";

// Map columns. The flow categories are drawn left → right in the direction requests usually flow; the support
// layers (network, security, observability, delivery, other services) hold what the flow relies on, and the map
// shows them only when their layer is switched on.
export type Category = "edge" | "compute" | "messaging" | "data" | "storage" | "external" | "network" | "security" | "observability" | "delivery" | "other";
export type Layer = "network" | "security" | "observability" | "delivery" | "other";
export const FLOW_ORDER: Category[] = ["edge", "compute", "messaging", "data", "storage", "external"];
export const SUPPORT_ORDER: Layer[] = ["network", "security", "observability", "delivery", "other"];
export const CATEGORY_ORDER: Category[] = [...FLOW_ORDER, ...SUPPORT_ORDER];
export const CATEGORY_LABEL: Record<Category, string> = {
  edge: "Edge & DNS",
  compute: "Compute",
  messaging: "Messaging & events",
  data: "Databases",
  storage: "Storage",
  external: "External",
  network: "Network",
  security: "Security & identity",
  observability: "Monitoring & logs",
  delivery: "Build & delivery",
  other: "Other services",
};
export const isSupport = (c: Category): c is Layer => (SUPPORT_ORDER as Category[]).includes(c);

// One entry per kind of node. Keep in sync with KIND_INFO below.
export type ResourceKind =
  // edge
  | "cloudflare-zone" | "route53-zone" | "cloudfront" | "apigateway" | "loadbalancer"
  | "classic-elb" | "global-accelerator" | "transfer-server" | "appsync-api" | "lattice-service"
  // compute
  | "ecs-service" | "ec2-instance" | "asg" | "lambda" | "eks-cluster" | "eks-workload" | "apprunner" | "beanstalk"
  | "workload" // declared in console.config.json: an app AWS can't see as a service (docker compose on EC2, another platform)
  | "amplify-app" | "lightsail-instance" | "lightsail-container" | "batch-environment" | "batch-queue"
  | "sagemaker-endpoint" | "sagemaker-notebook" | "bedrock-agent" | "bedrock-provisioned-throughput"
  // messaging
  | "sqs" | "sns" | "eventbridge-rule" | "eventbridge-bus" | "kinesis" | "stepfunctions"
  | "msk-cluster" | "mq-broker" | "firehose-stream" | "schedule" | "pipe" | "ses-identity"
  // data
  | "rds" | "elasticache" | "dynamodb"
  | "rds-cluster" | "docdb-cluster" | "neptune-cluster" | "rds-proxy" | "elasticache-serverless" | "memorydb-cluster"
  | "opensearch-domain" | "redshift-cluster" | "redshift-workgroup" | "glue-job" | "glue-crawler" | "athena-workgroup"
  | "lightsail-database" | "bedrock-knowledge-base"
  // storage
  | "s3" | "efs-filesystem" | "ebs-volume" | "fsx-filesystem"
  // external (declared in console.config.json, or a hostname nothing in the account answers)
  | "external"
  // network
  | "vpc" | "subnet" | "nat-gateway" | "internet-gateway" | "vpc-endpoint" | "vpc-peering" | "transit-gateway-attachment"
  | "elastic-ip" | "vpn-connection" | "security-group" | "cloudmap-namespace" | "cloudmap-service" | "network-firewall"
  | "resolver-endpoint" | "resolver-rule" | "lattice-service-network"
  // security
  | "iam-role" | "kms-key" | "acm-certificate" | "secret" | "ssm-parameter" | "waf-acl" | "cognito-user-pool" | "backup-plan"
  | "backup-vault"
  // observability
  | "log-group" | "cloudwatch-alarm" | "synthetics-canary" | "health-check" | "cloudtrail-trail"
  // delivery
  | "ecr-repository" | "pipeline" | "codebuild-project" | "codedeploy-group" | "cfn-stack"
  // other: anything the catch-all lists that no first-class provider reads (its type is in Resource.resourceType)
  | "aws-resource";

// label: what one is called; service: the AWS service people know it by (grouping, filters); provider: the provider
// that owns the kind, when its id isn't obvious from the service (Settings → AWS permissions uses it). Canonical keys of
// the new kinds are full ARNs built with arnOf (./arn.ts), so every package produces identical keys.
export const KIND_INFO: Record<ResourceKind, { label: string; category: Category; service: string; provider?: string }> = {
  "cloudflare-zone": { label: "Cloudflare zone", category: "edge", service: "Cloudflare" },
  "route53-zone": { label: "Route 53 zone", category: "edge", service: "Route 53" },
  cloudfront: { label: "CloudFront distribution", category: "edge", service: "CloudFront" },
  apigateway: { label: "API Gateway API", category: "edge", service: "API Gateway" },
  loadbalancer: { label: "Load balancer", category: "edge", service: "Elastic Load Balancing" },
  "classic-elb": { label: "Classic load balancer", category: "edge", service: "Elastic Load Balancing", provider: "elb-classic" },
  "global-accelerator": { label: "Global Accelerator", category: "edge", service: "Global Accelerator", provider: "globalaccelerator" },
  "transfer-server": { label: "Transfer Family server", category: "edge", service: "Transfer Family", provider: "transfer" },
  "appsync-api": { label: "AppSync API", category: "edge", service: "AppSync", provider: "appsync" },
  "lattice-service": { label: "Lattice service", category: "edge", service: "VPC Lattice", provider: "vpc-lattice" },
  "ecs-service": { label: "ECS service", category: "compute", service: "ECS" },
  "ec2-instance": { label: "EC2 instance", category: "compute", service: "EC2" },
  asg: { label: "Auto Scaling group", category: "compute", service: "EC2 Auto Scaling" },
  lambda: { label: "Lambda function", category: "compute", service: "Lambda" },
  "eks-cluster": { label: "EKS cluster", category: "compute", service: "EKS" },
  "eks-workload": { label: "Kubernetes workload", category: "compute", service: "EKS" },
  apprunner: { label: "App Runner service", category: "compute", service: "App Runner" },
  beanstalk: { label: "Elastic Beanstalk environment", category: "compute", service: "Elastic Beanstalk" },
  workload: { label: "Declared workload", category: "compute", service: "Declared" },
  "amplify-app": { label: "Amplify app", category: "compute", service: "Amplify", provider: "amplify" },
  "lightsail-instance": { label: "Lightsail instance", category: "compute", service: "Lightsail", provider: "lightsail" },
  "lightsail-container": { label: "Lightsail container service", category: "compute", service: "Lightsail", provider: "lightsail" },
  "batch-environment": { label: "Batch compute environment", category: "compute", service: "Batch", provider: "batch" },
  "batch-queue": { label: "Batch job queue", category: "compute", service: "Batch", provider: "batch" },
  "sagemaker-endpoint": { label: "SageMaker endpoint", category: "compute", service: "SageMaker", provider: "sagemaker" },
  "sagemaker-notebook": { label: "SageMaker notebook instance", category: "compute", service: "SageMaker", provider: "sagemaker" },
  "bedrock-agent": { label: "Bedrock agent", category: "compute", service: "Bedrock", provider: "bedrock" },
  "bedrock-provisioned-throughput": { label: "Bedrock provisioned throughput", category: "compute", service: "Bedrock", provider: "bedrock" },
  sqs: { label: "SQS queue", category: "messaging", service: "SQS" },
  sns: { label: "SNS topic", category: "messaging", service: "SNS" },
  "eventbridge-rule": { label: "EventBridge rule", category: "messaging", service: "EventBridge" },
  "eventbridge-bus": { label: "EventBridge bus", category: "messaging", service: "EventBridge" },
  kinesis: { label: "Kinesis stream", category: "messaging", service: "Kinesis" },
  stepfunctions: { label: "Step Functions state machine", category: "messaging", service: "Step Functions" },
  "msk-cluster": { label: "MSK cluster", category: "messaging", service: "MSK", provider: "msk" },
  "mq-broker": { label: "MQ broker", category: "messaging", service: "Amazon MQ", provider: "mq" },
  "firehose-stream": { label: "Firehose stream", category: "messaging", service: "Firehose", provider: "firehose" },
  schedule: { label: "EventBridge schedule", category: "messaging", service: "EventBridge Scheduler", provider: "scheduler" },
  pipe: { label: "EventBridge pipe", category: "messaging", service: "EventBridge Pipes", provider: "pipes" },
  "ses-identity": { label: "SES identity", category: "messaging", service: "SES", provider: "ses" },
  rds: { label: "RDS database", category: "data", service: "RDS" },
  elasticache: { label: "ElastiCache cluster", category: "data", service: "ElastiCache" },
  dynamodb: { label: "DynamoDB table", category: "data", service: "DynamoDB" },
  "rds-cluster": { label: "RDS cluster", category: "data", service: "RDS", provider: "rds-cluster" },
  "docdb-cluster": { label: "DocumentDB cluster", category: "data", service: "DocumentDB", provider: "rds-cluster" },
  "neptune-cluster": { label: "Neptune cluster", category: "data", service: "Neptune", provider: "rds-cluster" },
  "rds-proxy": { label: "RDS proxy", category: "data", service: "RDS", provider: "rds-cluster" },
  "elasticache-serverless": { label: "ElastiCache serverless cache", category: "data", service: "ElastiCache", provider: "elasticache-serverless" },
  "memorydb-cluster": { label: "MemoryDB cluster", category: "data", service: "MemoryDB", provider: "memorydb" },
  "opensearch-domain": { label: "OpenSearch domain", category: "data", service: "OpenSearch", provider: "opensearch" },
  "redshift-cluster": { label: "Redshift cluster", category: "data", service: "Redshift", provider: "redshift" },
  "redshift-workgroup": { label: "Redshift Serverless workgroup", category: "data", service: "Redshift", provider: "redshift" },
  "glue-job": { label: "Glue job", category: "data", service: "Glue", provider: "glue" },
  "glue-crawler": { label: "Glue crawler", category: "data", service: "Glue", provider: "glue" },
  "athena-workgroup": { label: "Athena workgroup", category: "data", service: "Athena", provider: "athena" },
  "lightsail-database": { label: "Lightsail database", category: "data", service: "Lightsail", provider: "lightsail" },
  "bedrock-knowledge-base": { label: "Bedrock knowledge base", category: "data", service: "Bedrock", provider: "bedrock" },
  s3: { label: "S3 bucket", category: "storage", service: "S3" },
  "efs-filesystem": { label: "EFS file system", category: "storage", service: "EFS", provider: "efs" },
  "ebs-volume": { label: "EBS volume", category: "storage", service: "EBS", provider: "ebs" },
  "fsx-filesystem": { label: "FSx file system", category: "storage", service: "FSx", provider: "fsx" },
  external: { label: "External system", category: "external", service: "External" },
  vpc: { label: "VPC", category: "network", service: "VPC", provider: "vpc" },
  subnet: { label: "Subnet", category: "network", service: "VPC", provider: "vpc" },
  "nat-gateway": { label: "NAT gateway", category: "network", service: "VPC", provider: "vpc" },
  "internet-gateway": { label: "Internet gateway", category: "network", service: "VPC", provider: "vpc" },
  "vpc-endpoint": { label: "VPC endpoint", category: "network", service: "VPC", provider: "vpc" },
  "vpc-peering": { label: "VPC peering connection", category: "network", service: "VPC", provider: "vpc" },
  "transit-gateway-attachment": { label: "Transit gateway attachment", category: "network", service: "VPC", provider: "vpc" },
  "elastic-ip": { label: "Elastic IP", category: "network", service: "VPC", provider: "vpc" },
  "vpn-connection": { label: "VPN connection", category: "network", service: "VPC", provider: "vpc" },
  "security-group": { label: "Security group", category: "network", service: "VPC", provider: "security-group" },
  "cloudmap-namespace": { label: "Cloud Map namespace", category: "network", service: "Cloud Map", provider: "cloudmap" },
  "cloudmap-service": { label: "Cloud Map service", category: "network", service: "Cloud Map", provider: "cloudmap" },
  "network-firewall": { label: "Network firewall", category: "network", service: "Network Firewall", provider: "network-firewall" },
  "resolver-endpoint": { label: "Resolver endpoint", category: "network", service: "Route 53 Resolver", provider: "route53-resolver" },
  "resolver-rule": { label: "Resolver rule", category: "network", service: "Route 53 Resolver", provider: "route53-resolver" },
  "lattice-service-network": { label: "Lattice service network", category: "network", service: "VPC Lattice", provider: "vpc-lattice" },
  "iam-role": { label: "IAM role", category: "security", service: "IAM", provider: "iam" },
  "kms-key": { label: "KMS key", category: "security", service: "KMS", provider: "kms" },
  "acm-certificate": { label: "ACM certificate", category: "security", service: "Certificate Manager", provider: "acm" },
  secret: { label: "Secret", category: "security", service: "Secrets Manager", provider: "secrets" },
  "ssm-parameter": { label: "SSM parameter", category: "security", service: "Systems Manager", provider: "ssm" },
  "waf-acl": { label: "WAF web ACL", category: "security", service: "WAF", provider: "waf" },
  "cognito-user-pool": { label: "Cognito user pool", category: "security", service: "Cognito", provider: "cognito" },
  "backup-plan": { label: "Backup plan", category: "security", service: "AWS Backup", provider: "backup" },
  "backup-vault": { label: "Backup vault", category: "security", service: "AWS Backup", provider: "backup" },
  "log-group": { label: "Log group", category: "observability", service: "CloudWatch Logs", provider: "logs" },
  "cloudwatch-alarm": { label: "CloudWatch alarm", category: "observability", service: "CloudWatch", provider: "alarms" },
  "synthetics-canary": { label: "Synthetics canary", category: "observability", service: "CloudWatch Synthetics", provider: "synthetics" },
  "health-check": { label: "Route 53 health check", category: "observability", service: "Route 53", provider: "route53" },
  "cloudtrail-trail": { label: "CloudTrail trail", category: "observability", service: "CloudTrail", provider: "cloudtrail" },
  "ecr-repository": { label: "ECR repository", category: "delivery", service: "ECR", provider: "ecr" },
  pipeline: { label: "CodePipeline pipeline", category: "delivery", service: "CodePipeline", provider: "codepipeline" },
  "codebuild-project": { label: "CodeBuild project", category: "delivery", service: "CodeBuild", provider: "codebuild" },
  "codedeploy-group": { label: "CodeDeploy deployment group", category: "delivery", service: "CodeDeploy", provider: "codedeploy" },
  "cfn-stack": { label: "CloudFormation stack", category: "delivery", service: "CloudFormation", provider: "cloudformation" },
  "aws-resource": { label: "AWS resource", category: "other", service: "AWS", provider: "catchall" },
};

// Use these, not KIND_INFO[r.kind].category / .label / .service, for a *resource*: a generic aws-resource carries its
// own category, service and type (from the catch-all), and a kind a newer server sends must not crash an older UI.
export const categoryOf = (r: Pick<Resource, "kind" | "category">): Category => r.category ?? KIND_INFO[r.kind]?.category ?? "other";
export const kindLabelOf = (r: Pick<Resource, "kind" | "resourceType" | "service">): string =>
  r.kind === "aws-resource" && r.resourceType ? infoOf(r.resourceType).label : KIND_INFO[r.kind]?.label ?? r.kind;
export const serviceOf = (r: Pick<Resource, "kind" | "service">): string => r.service ?? KIND_INFO[r.kind]?.service ?? "AWS";

// Coarse health for the map. Providers set it from what the service itself reports (function state, queue with a
// full DLQ, distribution disabled, instance stopped…); "idle" is added by the inventory from activity metrics.
export type Health = "ok" | "warning" | "error" | "stopped" | "unknown";

// How far a per-resource optional read (tags, policies, last run…) got: ok, skipped for time, denied by IAM, failed,
// or not attempted because the provider's per-type cap was reached (R18).
export type EnrichState = "ok" | "skipped" | "denied" | "error" | "capped";

// Machine-readable facts, set only by the provider that owns the resource (the cross-resource rules in
// ./propagate.ts read them). Documented names:
//   public (boolean: publicly addressable — RDS/cluster PubliclyAccessible, EC2 public IP, ECS assignPublicIp,
//     internet-facing LB, OpenSearch outside a VPC, public Redshift/MQ)
//   security groups: openIngress ["5432/tcp", "all"], cidrIngress ["5432/tcp<-10.1.0.0/16"], attachments (ENI count),
//     referencedBy (rules in other groups naming this one), peerGroups (groups this one's rules admit), isDefault
//   subnets: routesToIgw, naclOpen (inbound port ranges the NACL allows from 0.0.0.0/0, ["all"] for default NACLs)
//   KMS: state, deletionDate · ACM: notAfter, inUse, autoRenew · alarms: alarmState, scaling
//   IAM: neverUsed · backup: lastBackupAt, lastBackups ["<arn>|<iso>|<state>"] · ECR: tagDigests ["<tag>|<digest>"]
export type Facts = Record<string, string | number | boolean | string[]>;

export interface Prop {
  label: string; // "Runtime"
  value: string; // "nodejs22.x" — never a secret value (no env var values, no connection strings with passwords)
  mono?: boolean; // show in monospace (ARNs, ids, hostnames)
}

export interface Resource {
  // Stable id: the ARN when AWS has one ("arn:aws:lambda:us-east-1:123456789012:function:orders"), else
  // "<provider>:<id>" ("cloudflare:zone/abc", "external:stripe"). Two providers reporting the same key are merged.
  key: string;
  kind: ResourceKind;
  provider: string; // provider id that produced it ("lambda")
  name: string; // what people call it: Name tag, function name, bucket name…
  region: string; // "global" for CloudFront, Route 53, Cloudflare, IAM-level things
  tags: Record<string, string>;
  health: Health;
  healthReason?: string; // one line: "last 3 invocations failed", "DLQ holds 14 messages"
  props: Prop[]; // what the detail panel shows first
  // Where it lives on the network (for security-group edges and VPC grouping).
  vpcId?: string;
  subnetIds?: string[];
  securityGroups?: string[];
  // Hostnames / IPs / URLs it answers on, so DNS records, CloudFront origins and env vars can point at it:
  // ALB DNS name, CloudFront domain, API Gateway invoke domain, S3 website/REST endpoints, public/elastic IPs.
  endpoints?: string[];
  // Other names it's known by in configuration (queue URL, bucket name, table name, function name) — mentions match these.
  aliases?: string[];
  envHint?: string; // the environment the provider knows for certain (the ECS cluster's, a declared workload's): decides before tags
  lastActivityAt?: number; // when the provider itself knows the last activity (simulated data, S3 last write…); metrics win
  consoleUrl?: string; // deep link to the AWS console page
  createdAt?: number;
  lastModified?: number;
  // Coverage fields (all optional; providers that don't know them leave them out):
  parent?: string; // key of the resource it belongs to (subnet → VPC, NAT → subnet, Aurora member → cluster); folded on the map
  service?: string; // AWS service display name ("SageMaker") when the kind doesn't say it — set on aws-resource
  resourceType?: string; // Resource Explorer type ("sagemaker:endpoint") — set on aws-resource
  category?: Category; // overrides KIND_INFO's — set on aws-resource
  source?: "provider" | "resource-explorer" | "tagging" | "config" | "cloudcontrol" | "reference"; // what listed it (default provider)
  hidden?: boolean; // resolvable and listed in the table, never drawn (AWS-managed keys, service roles, table-only types)
  facts?: Facts; // see Facts above: owner-set only
  tagsUnread?: boolean; // tags were not read (cap, time budget, AccessDenied): protection must fail closed (R01, I06)
  account?: string; // owning account id, when it isn't the console's own
  observedAt?: number; // when the provider read it (persisted or partial runs serve older data)
  enrichment?: Record<string, EnrichState>; // per optional read (label → state), e.g. { tags: "capped", policy: "denied" }
  slim?: boolean; // sent without props / facts (table-only, hidden and generic rows); the detail call loads the rest
  // Filled in by the inventory, never by providers:
  env?: string; // assigned environment id ("production", "staging", or a tag value); undefined = shared/unassigned
  protectedBy?: string; // why changes here follow the protected-environment rules (any hint of a protected env counts)
  envWhy?: string; // "tag Environment=production", "name contains prod", "connected to staging/api", "VPC vpc-prod"
  idle?: { since?: number; why: string }; // no activity over the idle window (see idle.ts)
  notes?: number; // number of notes attached (see notes)
}

export type EdgeKind =
  | "route" // DNS / CDN / gateway / LB sends requests to it
  | "invoke" // calls or triggers it (API Gateway → Lambda, Step Functions → Lambda)
  | "event" // delivers events (S3 notification, EventBridge rule target, SNS subscription)
  | "poll" // pulls from it (Lambda event source mapping on SQS / Kinesis / DynamoDB stream)
  | "sql" | "cache" | "stream" // data connections (from ports / engines)
  | "reads" | "writes" // named in configuration or allowed by IAM, direction known
  | "uses" // named in configuration, direction unknown
  | "http" // generic network path (security groups, ports)
  // Support relationships (drawn dotted, only with their layer on):
  | "assumes" // runs as this IAM role (ECS task role, Lambda execution role, instance profile)
  | "encrypts" // KMS key → what it encrypts
  | "tls" // certificate → what serves it
  | "protects" // WAF ACL / backup plan → what it protects
  | "monitors" // alarm / health check / canary → what it watches (a scaling alarm: label "scales")
  | "logs" // writes its logs to (log group, bucket)
  | "pulls" // pulls its image from (ECR repository)
  | "manages" // stack / pipeline / namespace → what it creates or deploys
  | "mounts"; // mounts this file system
export const SUPPORT_EDGES: EdgeKind[] = ["assumes", "encrypts", "tls", "protects", "monitors", "logs", "pulls", "manages", "mounts"];

// How DNS splits traffic over a record's targets (Route 53 routing policies; Cloudflare is always "simple").
export interface Routing {
  policy: "simple" | "weighted" | "failover" | "latency" | "geolocation" | "geoproximity" | "multivalue" | "ip";
  weight?: number;
  role?: "primary" | "secondary";
  setId?: string; // the record's SetIdentifier
}

export interface Edge {
  id: string; // `${from}->${to}:${kind}`
  from: string; // resource keys
  to: string;
  kind: EdgeKind;
  label?: string; // "postgres:5432", "orders-dlq (redrive)", "/api/* → alb"
  evidence: string[]; // how we know: "event source mapping (enabled, batch 10)", "env ORDERS_QUEUE_URL", "security group sg-1 allows sg-2 on 5432"
  confidence: "config" | "allowed" | "mentioned"; // read from AWS config > allowed by SG/IAM > a string mentions it
  routing?: Routing;
  observedAt?: number;
}

// What a provider hands the inventory.
export interface Link {
  from: string; // resource key, or a reference resolved like a mention (ARN, URL, hostname, name)
  to: string;
  kind: EdgeKind;
  label?: string;
  evidence: string;
  // Default "config". Adapters of existing inference (the ECS catalog's security-group and connection-string edges)
  // pass "allowed" / "mentioned" so the map keeps saying how sure it is.
  confidence?: Edge["confidence"];
  routing?: Routing;
}
export interface Mention {
  from: string; // resource key
  refs: string[]; // raw strings: env var values (server-side only), origin domains, targets…
  via: string; // "env ORDERS_QUEUE_URL" — never the value itself when it may be secret
}

// One security group's inbound rules, as the security-group provider read them (CC-19: these replace the inventory's
// separate cloud.securityGroups() call for "allowed" edges, so groups are read once per build).
export interface SecurityGroupFacts {
  groupId: string;
  vpcId?: string;
  region: string;
  name?: string;
  inbound: { protocol: string; fromPort?: number; toPort?: number; groups: string[]; cidrs: string[]; prefixLists: string[]; description?: string }[];
}

export interface ProviderResult {
  resources: Resource[];
  links: Link[];
  mentions: Mention[];
  sgRules?: SecurityGroupFacts[];
}

// Per-provider discovery outcome, for the map's footer and Settings → AWS permissions.
export interface ProviderStatus {
  id: string;
  label: string;
  state: "ok" | "denied" | "error" | "disabled" | "skipped";
  count: number;
  missing?: string[]; // IAM actions AWS said were denied ("lambda:ListFunctions")
  error?: string;
  ms?: number;
  at: number;
  regions?: RegionStatus[]; // one row per region the provider ran in (multi-region and global providers)
  partial?: boolean; // the deadline cut a run short: what it listed before the cut is shown (R18)
  notes?: string[]; // "skipped in ap-east-1: not offered in this region"
}

export interface RegionStatus {
  region: string;
  state: ProviderStatus["state"];
  count: number;
  ms?: number;
  error?: string;
  missing?: string[];
  partial?: boolean;
  at: number;
}

// How much of the account the current map actually covers (Settings, the map's footer, agents).
export interface InventoryCompleteness {
  lastCompleteAt?: number; // the last build in which every enabled provider finished ok in every region
  providers: Record<"ok" | "denied" | "error" | "skipped" | "disabled" | "partial", number>; // provider × region runs by outcome
  cappedTypes: string[]; // "lambda:function@us-east-1" — more exist than were listed
  deniedActions: string[]; // IAM actions AWS refused
  staleProviders: string[]; // served from an older run ("logs@eu-west-1")
  unresolvedRefs: number; // links / mentions that named nothing in the account
  enrichmentSkipped: number; // per-resource optional reads skipped, denied or capped
}

// What GET /api/inventory returns (secrets never included).
export interface InventoryView {
  region: string;
  accountId?: string;
  generatedAt: number;
  resources: Resource[];
  edges: Edge[];
  envs: { id: string; label: string; protected: boolean; source: "ecs" | "tags" | "names" | "config" }[];
  providers: ProviderStatus[];
  truncated?: string[]; // "lambda: showing the first 2,000 functions"
  regions?: string[]; // the console's regions, home first
  homeRegion?: string;
  hiddenTypes?: Record<string, number>; // generic types dropped as sub-objects ("ec2:network-interface": 14)
  partial?: { pendingRegions: string[] }; // home and global runs are in; these regions are still being read
  completeness?: InventoryCompleteness;
  activity?: { metricsLastHour: number; estMonthlyUsd: number }; // CloudWatch metric reads for idle detection, and their cost
}

// A resource's extra detail, loaded when its panel opens (versions, aliases, subscriptions, objects…).
export interface ResourceDetail {
  key: string;
  sections: { title: string; rows?: Prop[]; table?: { columns: string[]; rows: string[][] }; note?: string }[];
  metrics?: { id: string; label: string; unit?: string; points: [number, number][] }[];
  page?: { prefix?: string; next?: string }; // browsing inside a resource (S3 prefixes): pass next back as ?token=
}

// An action a person (or an agent) can run on a resource — deploy code, shift an alias, purge a queue, invalidate a
// CDN path… The catalog the UI renders; execution goes through POST /api/inventory/action.
export interface ActionInfo {
  provider: string;
  id: string; // "deploy-code"
  kind: ResourceKind;
  title: string;
  description: string;
  risk: "change" | "danger";
  perm: string; // a Perm from src/lib/rbac.ts
  input: unknown; // JsonSchema (src/lib/server/ops/types.ts)
  allowed?: boolean; // for the caller, on this resource (role × protected env)
  blocked?: string; // why it can't run on this resource right now (ProviderAction.when) — show on the disabled button
  // For people (REVIEW: every action shows its impact, whether it can be undone and how success is verified):
  summary?: string; // one plain sentence: "Sends the queue's messages back to the source queue"
  note?: string; // caveat shown under the form
  iam?: string[]; // the IAM actions it needs ("sqs:StartMessageMoveTask")
  warning?: string; // shown prominently before confirming
  undo?: string; // "Start restores the saved task count" | "Irreversible"
  verifies?: string; // "Healthy when all tasks of the new revision are running"
}

// Keys for resources that the ECS side of the console also shows (its resource panel), so notes, links and the map
// agree without knowing the account id. Everything else uses its ARN (Lambda, SQS, SNS, S3 `arn:aws:s3:::bucket`…),
// or "<provider>:<id>" when AWS has no ARN (Cloudflare zones, Kubernetes workloads, externals).
// Multi-region (CC-6): outside the home region these keys get an "@<region>" suffix, so a database in eu-west-1 never
// collides with the home one of the same name. Pass both region and home; with either missing the key is region-less
// (today's single-region keys, unchanged).
const at = (region?: string, home?: string) => (region && home && region !== home ? `@${region}` : "");
export const keys = {
  ecsService: (cluster: string, service: string, region?: string, home?: string) => `ecs:service/${cluster}/${service}${at(region, home)}`,
  loadBalancer: (name: string, region?: string, home?: string) => `elb:${name}${at(region, home)}`,
  rds: (id: string, region?: string, home?: string) => `rds:${id}${at(region, home)}`,
  elasticache: (id: string, region?: string, home?: string) => `elasticache:${id}${at(region, home)}`,
  ec2: (instanceId: string, region?: string, home?: string) => `ec2:${instanceId}${at(region, home)}`,
  eksWorkload: (cluster: string, namespace: string, kind: string, name: string) => `eks:${cluster}/${namespace}/${kind}/${name}`,
  external: (id: string) => `external:${id}`,
  workload: (id: string) => `workload:${id}`,
};

// The region a key lives in: its "@<region>" suffix, else an ARN's region field, else home (region-less console keys,
// externals, and global ARNs such as IAM's).
// Region codes: "eu-west-1", "us-gov-west-1", "us-isob-east-1", "eusc-de-east-1" (the European Sovereign Cloud).
const REGION_SUFFIX = /@([a-z]{2,4}(?:-[a-z]+)+-\d{1,2})$/;
export function keyRegion(key: string, home: string): string {
  const suffix = REGION_SUFFIX.exec(key)?.[1];
  if (suffix) return suffix;
  if (key.startsWith("arn:")) return key.split(":")[3] || home;
  return home;
}

// Notes people attach to any resource (src/lib/server/notes.ts, /api/notes). Plain text with line breaks; links are
// made clickable when rendered, nothing else is interpreted (no HTML, no markdown execution).
export interface Note {
  id: string;
  key: string; // resource key (see keys above)
  body: string; // ≤ 10,000 chars
  tags: string[]; // short labels, lower-case, e.g. ["traffic", "incident"]
  pinned: boolean;
  author: string; // email
  createdAt: number;
  updatedAt: number;
  resourceName?: string; // name at the time of writing (the resource may be gone later)
  env?: string;
}

// HTTP API shared by the map UI and the server:
//   GET  /api/inventory                        → InventoryView (cached; ?refresh=1 re-discovers, rate-limited)
//   GET  /api/inventory/detail?key=<key>[&prefix=<p>&token=<t>] → ResourceDetail (page.next = the next token)
//   GET  /api/inventory/actions?key=<key>      → { actions: ActionInfo[] } (allowed = this caller, this resource)
//   POST /api/inventory/action { key, provider, action, input, confirm?, reason?, dryRun? }
//                                              → { plan } (dry run) | 202 { result } — plan first, then confirm
//   GET  /api/notes?key=<key>                  → { notes: Note[] }      (any signed-in person)
//   GET  /api/notes?q=<text>&tag=<tag>         → { notes: Note[] }      search across resources
//   GET  /api/notes/tags                       → { tags: { tag: string; count: number }[] } (suggestions)
//   POST /api/notes { key, body, tags?, pinned?, resourceName?, env? } → 201 { note }   (perm "notes")
//   PATCH /api/notes/<id> { body?, tags?, pinned? } → { note }  ·  DELETE /api/notes/<id>   (author or admin)
