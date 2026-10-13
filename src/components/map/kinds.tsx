"use client";
// Visual vocabulary of the cloud map: one lucide icon per kind, health colours (the console's state tokens), edge
// families and confidence styles. Shared by the canvas, the legend and the resource panel.
import {
  Activity, AlarmClock, Anchor, Archive, ArrowLeftRight, ArrowRightLeft, BadgeCheck, Blocks, Bot, Boxes, Braces, BrainCircuit, BrickWall, Building2,
  Cable, CalendarClock, CalendarSync, Clock, Cloud, CloudUpload, Cog, Coins, Component, Container, Cpu, Database, DatabaseZap, Earth, Eye, Factory,
  FileJson, FileKey, Film, Flame, FolderOpen, FolderTree, Folders, Footprints, Gauge, GitBranch, GitMerge, Globe, Grid3x3, Hammer, HardDrive,
  Headphones, HeartPulse, Hexagon, IdCard, Inbox, KeyRound, Lambda, Layers, Layers3, LayoutGrid, Library, Link2, ListChecks, Lock, LockKeyhole,
  Mail, MapPin, Megaphone, MessageSquare, MessagesSquare, Microchip, Monitor, Network, NotebookPen, Orbit, Package, Package2, PackageOpen, Pipette,
  Plug, Puzzle, Radar, Radio, Rocket, Router, Rss, Sailboat, Satellite, Scale, ScanSearch, ScrollText, Search, Send, Server, Share2, Shield,
  ShieldAlert, ShieldCheck, ShieldHalf, Ship, Shuffle, Signpost, Siren, Smartphone, Sparkles, Spline, Split, Sprout, SquareTerminal, Table2,
  Telescope, Ticket, Truck, Users, Vault, Wallet, Warehouse, Waypoints, Webhook, Workflow, Wrench, Zap, type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { infoOf, SERVICES, type ServiceIcon } from "@/lib/inventory/aws-services";
import { KIND_INFO, type Edge, type EdgeKind, type Health, type Resource, type ResourceKind, type Routing } from "@/lib/inventory/types";

export const KIND_ICON: Record<ResourceKind, LucideIcon> = {
  "cloudflare-zone": Cloud,
  "route53-zone": Signpost,
  cloudfront: Globe,
  apigateway: Webhook,
  loadbalancer: Network,
  "classic-elb": Scale,
  "global-accelerator": Gauge,
  "transfer-server": CloudUpload,
  "appsync-api": Braces,
  "lattice-service": Component,
  "ecs-service": Container,
  "ec2-instance": Server,
  asg: Layers,
  lambda: Lambda,
  "eks-cluster": Ship,
  "eks-workload": Boxes,
  apprunner: Rocket,
  beanstalk: Sprout,
  workload: Package,
  "amplify-app": Sparkles,
  "lightsail-instance": Sailboat,
  "lightsail-container": Anchor,
  "batch-environment": Factory,
  "batch-queue": ListChecks,
  "sagemaker-endpoint": BrainCircuit,
  "sagemaker-notebook": NotebookPen,
  "bedrock-agent": Bot,
  "bedrock-provisioned-throughput": Microchip,
  sqs: Inbox,
  sns: Megaphone,
  "eventbridge-rule": CalendarClock,
  "eventbridge-bus": Radio,
  kinesis: Activity,
  stepfunctions: Workflow,
  "msk-cluster": Rss,
  "mq-broker": MessagesSquare,
  "firehose-stream": Flame,
  schedule: AlarmClock,
  pipe: Pipette,
  "ses-identity": Mail,
  rds: Database,
  elasticache: DatabaseZap,
  dynamodb: Table2,
  "rds-cluster": Database,
  "docdb-cluster": FileJson,
  "neptune-cluster": Share2,
  "rds-proxy": Shuffle,
  "elasticache-serverless": Zap,
  "memorydb-cluster": Cpu,
  "opensearch-domain": Search,
  "redshift-cluster": Warehouse,
  "redshift-workgroup": Building2,
  "glue-job": Cog,
  "glue-crawler": ScanSearch,
  "athena-workgroup": Telescope,
  "lightsail-database": Database,
  "bedrock-knowledge-base": Library,
  s3: Archive,
  "efs-filesystem": FolderOpen,
  "ebs-volume": HardDrive,
  "fsx-filesystem": Folders,
  external: Plug,
  vpc: Hexagon,
  subnet: Grid3x3,
  "nat-gateway": ArrowRightLeft,
  "internet-gateway": Earth,
  "vpc-endpoint": Cable,
  "vpc-peering": Link2,
  "transit-gateway-attachment": Waypoints,
  "elastic-ip": MapPin,
  "vpn-connection": Lock,
  "security-group": BrickWall,
  "cloudmap-namespace": FolderTree,
  "cloudmap-service": Radar,
  "network-firewall": ShieldHalf,
  "resolver-endpoint": Router,
  "resolver-rule": Split,
  "lattice-service-network": Orbit,
  "iam-role": IdCard,
  "kms-key": KeyRound,
  "acm-certificate": BadgeCheck,
  secret: LockKeyhole,
  "ssm-parameter": FileKey,
  "waf-acl": ShieldCheck,
  "cognito-user-pool": Users,
  "backup-plan": CalendarSync,
  "backup-vault": Vault,
  "log-group": ScrollText,
  "cloudwatch-alarm": Siren,
  "synthetics-canary": Activity,
  "health-check": HeartPulse,
  "cloudtrail-trail": Footprints,
  "ecr-repository": PackageOpen,
  pipeline: GitMerge,
  "codebuild-project": Hammer,
  "codedeploy-group": Truck,
  "cfn-stack": Layers3,
  "aws-resource": Puzzle,
};

// Icons of the AWS services generic resources belong to (aws-services.ts SERVICES[…].icon); unknown → Puzzle.
export const SERVICE_ICON: Record<ServiceIcon, LucideIcon> = {
  Activity, AlarmClock, Archive, ArrowLeftRight, ArrowRightLeft, BadgeCheck, Blocks, Bot, Braces, BrainCircuit, Building2, Cable, CalendarSync, Clock,
  CloudUpload, Cog, Coins, Container, Cpu, Database, DatabaseZap, Eye, Factory, FileKey, Film, Flame, FolderOpen, Folders, Footprints, Gauge,
  GitBranch, GitMerge, Globe, Hammer, HardDrive, Headphones, HeartPulse, IdCard, Inbox, KeyRound, Lambda, Layers, Layers3, LayoutGrid, Library,
  Link2, ListChecks, LockKeyhole, Mail, Megaphone, MessageSquare, MessagesSquare, Microchip, Monitor, Network, Orbit, Package2, PackageOpen, Puzzle,
  Radar, Radio, Rocket, Router, Rss, Sailboat, Satellite, ScanSearch, ScrollText, Search, Send, Server, Share2, Shield, ShieldAlert, ShieldCheck,
  ShieldHalf, Ship, Signpost, Siren, Smartphone, Sparkles, Spline, Split, Sprout, SquareTerminal, Table2, Telescope, Ticket, Truck, Users, Vault,
  Wallet, Warehouse, Webhook, Workflow, Wrench, Zap,
};
// By ARN service prefix ("sagemaker") or Resource Explorer type ("sagemaker:endpoint").
export const serviceIcon = (serviceOrType: string): LucideIcon => {
  const prefix = serviceOrType.split(":")[0];
  return Object.hasOwn(SERVICES, prefix) ? SERVICE_ICON[SERVICES[prefix].icon] ?? Puzzle : Puzzle;
};
// The icon for one resource: a generic aws-resource takes its service's icon; a kind a newer server sends gets Puzzle.
export const iconOf = (r: Pick<Resource, "kind" | "resourceType">): LucideIcon =>
  r.kind === "aws-resource" && r.resourceType ? serviceIcon(r.resourceType) : KIND_ICON[r.kind] ?? Puzzle;

// Short names for chips, where "Lambda function" would not fit.
export const KIND_SHORT: Record<ResourceKind, string> = {
  "cloudflare-zone": "Cloudflare",
  "route53-zone": "Route 53",
  cloudfront: "CloudFront",
  apigateway: "API Gateway",
  loadbalancer: "Load balancer",
  "classic-elb": "CLB",
  "global-accelerator": "Accelerator",
  "transfer-server": "Transfer",
  "appsync-api": "AppSync",
  "lattice-service": "Lattice",
  "ecs-service": "ECS",
  "ec2-instance": "EC2",
  asg: "Auto Scaling",
  lambda: "Lambda",
  "eks-cluster": "EKS",
  "eks-workload": "Kubernetes",
  apprunner: "App Runner",
  beanstalk: "Beanstalk",
  workload: "Workload",
  "amplify-app": "Amplify",
  "lightsail-instance": "Lightsail",
  "lightsail-container": "Lightsail containers",
  "batch-environment": "Batch",
  "batch-queue": "Batch queue",
  "sagemaker-endpoint": "SageMaker",
  "sagemaker-notebook": "Notebook",
  "bedrock-agent": "Bedrock agent",
  "bedrock-provisioned-throughput": "Bedrock throughput",
  sqs: "SQS",
  sns: "SNS",
  "eventbridge-rule": "EventBridge rule",
  "eventbridge-bus": "Event bus",
  kinesis: "Kinesis",
  stepfunctions: "Step Functions",
  "msk-cluster": "MSK",
  "mq-broker": "MQ",
  "firehose-stream": "Firehose",
  schedule: "Schedule",
  pipe: "Pipe",
  "ses-identity": "SES",
  rds: "RDS",
  elasticache: "ElastiCache",
  dynamodb: "DynamoDB",
  "rds-cluster": "RDS cluster",
  "docdb-cluster": "DocumentDB",
  "neptune-cluster": "Neptune",
  "rds-proxy": "RDS proxy",
  "elasticache-serverless": "ElastiCache",
  "memorydb-cluster": "MemoryDB",
  "opensearch-domain": "OpenSearch",
  "redshift-cluster": "Redshift",
  "redshift-workgroup": "Redshift Serverless",
  "glue-job": "Glue job",
  "glue-crawler": "Glue crawler",
  "athena-workgroup": "Athena",
  "lightsail-database": "Lightsail DB",
  "bedrock-knowledge-base": "Knowledge base",
  s3: "S3",
  "efs-filesystem": "EFS",
  "ebs-volume": "EBS",
  "fsx-filesystem": "FSx",
  external: "External",
  vpc: "VPC",
  subnet: "Subnet",
  "nat-gateway": "NAT",
  "internet-gateway": "IGW",
  "vpc-endpoint": "Endpoint",
  "vpc-peering": "Peering",
  "transit-gateway-attachment": "TGW attachment",
  "elastic-ip": "Elastic IP",
  "vpn-connection": "VPN",
  "security-group": "Security group",
  "cloudmap-namespace": "Cloud Map",
  "cloudmap-service": "Cloud Map",
  "network-firewall": "Firewall",
  "resolver-endpoint": "Resolver",
  "resolver-rule": "Resolver rule",
  "lattice-service-network": "Lattice network",
  "iam-role": "IAM role",
  "kms-key": "KMS",
  "acm-certificate": "Certificate",
  secret: "Secret",
  "ssm-parameter": "Parameter",
  "waf-acl": "WAF",
  "cognito-user-pool": "Cognito",
  "backup-plan": "Backup plan",
  "backup-vault": "Backup vault",
  "log-group": "Logs",
  "cloudwatch-alarm": "Alarm",
  "synthetics-canary": "Canary",
  "health-check": "Health check",
  "cloudtrail-trail": "CloudTrail",
  "ecr-repository": "ECR",
  pipeline: "Pipeline",
  "codebuild-project": "CodeBuild",
  "codedeploy-group": "CodeDeploy",
  "cfn-stack": "Stack",
  "aws-resource": "AWS",
};
// A resource's short name: a generic aws-resource says what it is ("SageMaker model").
export const shortOf = (r: Pick<Resource, "kind" | "resourceType">): string =>
  r.kind === "aws-resource" && r.resourceType ? infoOf(r.resourceType).label : KIND_SHORT[r.kind] ?? r.kind;

// "42 Lambda functions", "3 EventBridge buses", "2 Bedrock provisioned throughputs".
export function kindPlural(kind: ResourceKind, n: number) {
  const label = KIND_INFO[kind]?.label ?? kind;
  if (n === 1) return `1 ${label}`;
  const plural = /(bus|address)$/.test(label) ? `${label}es` : `${label}s`;
  return `${n.toLocaleString()} ${plural}`;
}

export const HEALTH: Record<Health, { label: string; color: string; anim: "none" | "pulse" | "alarm" | "hatch"; rank: number }> = {
  error: { label: "Error", color: "var(--down)", anim: "alarm", rank: 0 },
  warning: { label: "Warning", color: "var(--degraded)", anim: "pulse", rank: 1 },
  unknown: { label: "Unknown", color: "var(--unknown)", anim: "hatch", rank: 2 },
  stopped: { label: "Stopped", color: "var(--stopped)", anim: "none", rank: 3 },
  ok: { label: "Healthy", color: "var(--up)", anim: "none", rank: 4 },
};
export const healthStyle = (h: Health) => ({ "--dot": HEALTH[h].color }) as CSSProperties;
export const isProblem = (h: Health) => h === "error" || h === "warning";

export function HealthDot({ health, still, className }: { health: Health; still?: boolean; className?: string }) {
  return <span className={`dot ${className ?? ""}`} data-anim={still ? "none" : HEALTH[health].anim} style={healthStyle(health)} aria-hidden />;
}

// Edge kinds, as a sentence fragment and grouped into families. Lines rest in the neutral hairline colour; a
// spotlit path takes its family's tint (categorical series tokens: lines only, ≥3:1 on the canvas). The support family
// (roles, keys, certificates, logs, images…) is drawn dotted and only with its layer on.
export const EDGE_VERB: Record<EdgeKind, string> = {
  route: "routes to",
  invoke: "invokes",
  event: "sends events to",
  poll: "polls",
  sql: "queries (SQL)",
  cache: "uses cache",
  stream: "streams to",
  reads: "reads",
  writes: "writes to",
  uses: "uses",
  http: "network path to",
  assumes: "runs as",
  encrypts: "encrypts",
  tls: "secures (TLS)",
  protects: "protects",
  monitors: "monitors",
  logs: "logs to",
  pulls: "pulls images from",
  manages: "manages",
  mounts: "mounts",
};
export const EDGE_LABEL: Record<EdgeKind, string> = {
  route: "Routes",
  invoke: "Invokes",
  event: "Events",
  poll: "Polls",
  sql: "SQL",
  cache: "Cache",
  stream: "Stream",
  reads: "Reads",
  writes: "Writes",
  uses: "Uses",
  http: "Network path",
  assumes: "Role",
  encrypts: "Encryption",
  tls: "Certificate",
  protects: "Protection",
  monitors: "Monitoring",
  logs: "Logs",
  pulls: "Image",
  manages: "Manages",
  mounts: "Mounts",
};
export type EdgeFamily = "traffic" | "calls" | "events" | "data" | "support";
export const EDGE_FAMILY: Record<EdgeKind, EdgeFamily> = {
  route: "traffic",
  http: "traffic",
  invoke: "calls",
  uses: "calls",
  event: "events",
  poll: "events",
  stream: "events",
  sql: "data",
  cache: "data",
  reads: "data",
  writes: "data",
  assumes: "support",
  encrypts: "support",
  tls: "support",
  protects: "support",
  monitors: "support",
  logs: "support",
  pulls: "support",
  manages: "support",
  mounts: "support",
};
export const FAMILY: Record<EdgeFamily, { label: string; color: string; kinds: EdgeKind[]; dash?: string }> = {
  traffic: { label: "Traffic", color: "var(--series-1)", kinds: ["route", "http"] },
  calls: { label: "Calls & use", color: "var(--series-2)", kinds: ["invoke", "uses"] },
  events: { label: "Events & polling", color: "var(--series-5)", kinds: ["event", "poll", "stream"] },
  data: { label: "Data", color: "var(--series-3)", kinds: ["sql", "cache", "reads", "writes"] },
  support: {
    label: "Support",
    color: "var(--series-6)",
    kinds: ["assumes", "encrypts", "tls", "protects", "monitors", "logs", "pulls", "manages", "mounts"],
    dash: "calc(1.5px / var(--zc, 1)) calc(3px / var(--zc, 1))",
  },
};

export const CONFIDENCE: Record<Edge["confidence"], { label: string; hint: string; dash?: string }> = {
  config: { label: "config", hint: "read from AWS configuration" },
  allowed: { label: "allowed", hint: "allowed by a security group or IAM policy", dash: "calc(5px / var(--zc, 1)) calc(4px / var(--zc, 1))" },
  mentioned: { label: "mentioned", hint: "a setting mentions it (env var, origin, target)", dash: "calc(1px / var(--zc, 1)) calc(3.5px / var(--zc, 1))" },
};

// R15: how DNS splits traffic over a record's targets, as a short edge label ("weighted 50", "failover primary").
// Simple routing says nothing.
export function routingText(r?: Routing): string | undefined {
  if (!r || r.policy === "simple") return undefined;
  if (r.policy === "weighted") return r.weight !== undefined ? `weighted ${r.weight}` : "weighted";
  if (r.policy === "failover") return r.role ? `failover ${r.role}` : "failover";
  return r.policy === "ip" ? "IP-based" : r.policy;
}
