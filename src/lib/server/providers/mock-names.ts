// One source of truth for the simulated "Acme" account beyond ECS, so every provider's simulated data links up:
// the orders queue the Lambda polls is the queue SQS lists, the bucket CloudFront serves is the bucket S3 lists,
// the DNS records point at the load balancer the ECS simulation already has. Pure constants — no AWS calls.
//
// Acme's story: an online shop. Storefront API / Jobs / Billing run on ECS (see ../mock.ts); around them, the kind of
// serverless and edge plumbing real teams accumulate — including a few things nobody uses anymore (idle).
export const ACCT = "123456789012";
export const REGION = "us-east-1"; // matches ../mock.ts
const arn = (svc: string, rest: string, region: string = REGION) => `arn:aws:${svc}:${region}:${ACCT}:${rest}`;
const globalArn = (svc: string, rest: string) => `arn:aws:${svc}::${ACCT}:${rest}`;

// The simulated account spans two regions. us-east-1 is the Acme estate below; eu-west-1 is a small second estate (EU,
// at the end of this file). A provider with `multiRegionMock` returns only ctx.region's resources; every other region
// is empty. This file is frozen after wave A: every mock takes its names from here, so packages agree without editing it.
export const MOCK_REGIONS: string[] = ["us-east-1", "eu-west-1"];
export const EU_REGION = "eu-west-1";

// Already simulated by ../mock.ts (ECS side) — referenced here, not re-created.
export const EXISTING = {
  vpc: { staging: "vpc-stg", production: "vpc-prod" },
  subnets: { production: ["subnet-prod-a", "subnet-prod-b"], staging: ["subnet-stg-a"] },
  securityGroups: {
    prodApi: "sg-prod-api", prodWorker: "sg-prod-worker", prodBilling: "sg-prod-billing", prodConsole: "sg-prod-console", prodDb: "sg-prod-db",
    prodValkey: "sg-prod-valkey", prodAlb: "sg-prod-alb", stagingBox: "sg-stg-box", stagingDb: "sg-stg-db",
  },
  alb: { name: "acme-production", dns: `acme-production-1839406127.${REGION}.elb.amazonaws.com`, arn: arn("elasticloadbalancing", "loadbalancer/app/acme-production/5f2c1a9d3e7b4c60") },
  rds: { staging: "acme-staging-pg", production: "acme-production-pg" },
  rdsHost: (id: string, region: string = REGION) => `${id}.c0example.${region}.rds.amazonaws.com`, // ../mock.ts dbHost()
  valkey: { id: "acme-production-valkey", host: "master.acme-production-valkey.x1y2z3.use1.cache.amazonaws.com" },
  clusters: { staging: "acme-staging", production: "acme-production" },
  ecsServices: { production: ["api", "worker", "billing", "deployment-console"], staging: ["api", "worker", "billing", "caddy", "redis"] },
  stagingBox: { id: "i-0a1b2c3d4e5f67890", name: "acme-staging", instanceProfile: globalArn("iam", "instance-profile/acme-ecs-instance") },
  // Variables the ECS services read (../mock.ts initialEnv): production keys in SSM and Secrets Manager, staging env files in S3.
  ssmParameter: (service: string) => `/acme/production/${service}/JWT_SIGNING_KEY`,
  secretName: (service: string) => `acme/production/${service}`, // ARN suffix "-Ab12Cd"
  secretArn: (service: string) => arn("secretsmanager", `secret:acme/production/${service}-Ab12Cd`),
  envFilesBucket: "acme-config",
};

export const LAMBDA = {
  thumbnailerStaging: { name: "acme-staging-thumbnailer", arn: arn("lambda", "function:acme-staging-thumbnailer"), runtime: "nodejs22.x", env: "staging" },
  thumbnailerProd: { name: "acme-production-thumbnailer", arn: arn("lambda", "function:acme-production-thumbnailer"), runtime: "nodejs22.x", env: "production" },
  orderEvents: { name: "acme-production-order-events", arn: arn("lambda", "function:acme-production-order-events"), runtime: "nodejs22.x", env: "production" },
  emailSender: { name: "acme-production-email-sender", arn: arn("lambda", "function:acme-production-email-sender"), runtime: "python3.13", env: "production" },
  nightlyReport: { name: "acme-production-nightly-report", arn: arn("lambda", "function:acme-production-nightly-report"), runtime: "python3.13", env: "production" },
  apiHandler: { name: "acme-production-public-api", arn: arn("lambda", "function:acme-production-public-api"), runtime: "nodejs22.x", env: "production" },
  partnersStaging: { name: "acme-staging-partners-api", arn: arn("lambda", "function:acme-staging-partners-api"), runtime: "nodejs22.x", env: "staging" },
  checkoutStep: { name: "acme-production-checkout-reserve", arn: arn("lambda", "function:acme-production-checkout-reserve"), runtime: "nodejs22.x", env: "production" },
  legacyCleanup: { name: "legacy-cron-cleanup", arn: arn("lambda", "function:legacy-cron-cleanup"), runtime: "nodejs18.x", env: undefined }, // idle, deprecated runtime
};

const queue = (name: string) => ({ name, arn: arn("sqs", name), url: `https://sqs.${REGION}.amazonaws.com/${ACCT}/${name}` });
export const SQS = {
  orders: queue("acme-production-orders"),
  ordersDlq: queue("acme-production-orders-dlq"), // redrive target of orders; holds a few failed messages
  emails: queue("acme-production-emails"),
  ordersStaging: queue("acme-staging-orders"),
  exportsOld: queue("acme-exports-old"), // idle
};

const topic = (name: string) => ({ name, arn: arn("sns", name) });
export const SNS = {
  notifications: topic("acme-production-notifications"), // → email-sender Lambda, → emails queue, → https webhook
  notificationsStaging: topic("acme-staging-notifications"),
  alarms: topic("acme-alarms"),
};

export const EVENTS = {
  defaultBus: { name: "default", arn: arn("events", "event-bus/default") },
  shopBus: { name: "acme-shop-events", arn: arn("events", "event-bus/acme-shop-events") },
  nightlyRule: { name: "acme-production-nightly-report", arn: arn("events", "rule/acme-production-nightly-report"), schedule: "cron(0 2 * * ? *)" }, // → nightly-report Lambda
  orderPlacedRule: { name: "acme-production-order-placed", arn: arn("events", "rule/acme-shop-events/acme-production-order-placed") }, // shop bus → orders queue + checkout state machine
};

export const SFN = {
  checkout: { name: "acme-production-checkout", arn: arn("states", "stateMachine:acme-production-checkout") }, // invokes checkout-reserve Lambda, publishes to notifications
};

export const KINESIS = {
  clickstream: { name: "acme-production-clickstream", arn: arn("kinesis", "stream/acme-production-clickstream") }, // polled by the EKS recommender (mentioned in its config)
};

const table = (name: string) => ({ name, arn: arn("dynamodb", `table/${name}`) });
export const DYNAMO = {
  sessions: table("acme-production-sessions"), // used by Storefront API (ECS env var) and public-api Lambda
  carts: table("acme-production-carts"),
  sessionsStaging: table("acme-staging-sessions"),
};

export const APIGW = {
  publicHttp: { name: "acme-production-public-api", id: "a1b2c3d4e5", type: "HTTP", domain: `a1b2c3d4e5.execute-api.${REGION}.amazonaws.com`, customDomain: "api-public.acme.example" }, // routes → public-api Lambda
  partnersRest: { name: "acme-staging-partners", id: "p9q8r7s6t5", type: "REST", domain: `p9q8r7s6t5.execute-api.${REGION}.amazonaws.com` }, // → partners Lambda
};

const bucket = (name: string) => ({ name, arn: `arn:aws:s3:::${name}`, domain: `${name}.s3.${REGION}.amazonaws.com` });
export const S3 = {
  assets: bucket("acme-production-assets"), // CloudFront origin
  uploads: bucket("acme-production-uploads"), // notifications → production thumbnailer
  uploadsStaging: bucket("acme-staging-uploads"), // notifications → staging thumbnailer
  logs: bucket("acme-logs"), // shared: ALB + CloudFront access logs
  backupsOld: bucket("acme-old-backups"), // idle
};

export const CLOUDFRONT = {
  shop: { id: "E2ACME1SHOP", domain: "d1a2b3c4shop.cloudfront.net", aliases: ["www.acme.example", "shop.acme-shop.com"] }, // origins: assets bucket (default), ALB for /api/*
  staging: { id: "E3ACMESTG", domain: "d9z8y7stg.cloudfront.net", aliases: ["staging.acme.example"] }, // origin: staging EC2 box (Caddy)
};

export const ROUTE53 = {
  zone: { id: "Z0ACMEEXAMPLE", name: "acme.example" }, // www → CloudFront, api → ALB, api-public → API Gateway, staging → staging CloudFront, bastion → EC2 bastion
};

export const CLOUDFLARE = {
  zone: { id: "cf0acme1shop2zone3", name: "acme-shop.com" }, // shop → CloudFront (proxied), status → external status page
};

export const EC2 = {
  bastion: { id: "i-0acmebastion0001", name: "acme-bastion", type: "t4g.nano", env: undefined as string | undefined, publicIp: "203.0.113.20" }, // .10 is the staging box (../mock.ts)
  legacyCron: { id: "i-0acmelegacy00002", name: "acme-legacy-cron", type: "t3.small", env: "production", state: "stopped" }, // idle
};

// A load balancer no ECS service uses (simulated by ../mock.ts, listed by providers/ecs.ts MOCK_LBS): an internal ALB in
// front of a status page on the bastion, whose health check fails — target health without any ECS join (R16).
export const STANDALONE_ALB = {
  name: "acme-ops-internal", arn: arn("elasticloadbalancing", "loadbalancer/app/acme-ops-internal/0c4e1d9a7b2f3e51"),
  dns: `internal-acme-ops-internal-402917355.${REGION}.elb.amazonaws.com`,
  tg: { name: "ops-status", arn: arn("elasticloadbalancing", "targetgroup/ops-status/7a1c3e5b9d2f4a60"), port: 8080, target: "i-0acmebastion0001" },
};

export const EKS = {
  cluster: { name: "acme-data-platform", arn: arn("eks", "cluster/acme-data-platform"), version: "1.33" }, // production, VPC vpc-prod
  nodegroup: { name: "general", instanceType: "m6i.large", desired: 2 },
  workloads: [
    { namespace: "ml", name: "recommender", kind: "Deployment", replicas: 3 }, // reads the clickstream stream, sessions table
    { namespace: "ml", name: "feature-store", kind: "StatefulSet", replicas: 2 }, // writes to the carts table
  ],
};

export const APPRUNNER = {
  preview: { name: "acme-staging-preview", arn: arn("apprunner", "service/acme-staging-preview/0f1e2d3c4b5a"), url: "abcd1234.us-east-1.awsapprunner.com" },
};

export const BEANSTALK = {
  app: "acme-legacy-admin",
  env: { name: "acme-legacy-admin-prod", id: "e-acmelegacy1", cname: "acme-legacy-admin-prod.us-east-1.elasticbeanstalk.com" }, // old admin, still up, talks to the production database
};

// ---------- coverage providers (the cloud map's support layers and the long tail) ----------
// Each block below is the simulated data of one or two providers. Comments tell the story the mock should tell.

// VPC networking. Production: public subnets for the ALB, private ones (NAT) for tasks and data. Staging: one public
// subnet for the ECS host, and a subnet *named* private that still routes 0.0.0.0/0 to the internet gateway — the
// exposed acme-staging-pg lives there (its group sg-stg-db also admits 5432 from 0.0.0.0/0: an error on the map).
export const NETWORK = {
  production: {
    vpc: "vpc-prod", cidr: "10.20.0.0/16", name: "acme-production",
    publicSubnets: ["subnet-prod-pub-a", "subnet-prod-pub-b"], privateSubnets: ["subnet-prod-a", "subnet-prod-b"], // tasks, RDS, cache
    igw: "igw-prod", nat: "nat-0prod0a1b2c3d4e5", s3Endpoint: "vpce-0prod0s3a1b2c3d4", routeTables: { public: "rtb-prod-public", private: "rtb-prod-private" },
  },
  staging: {
    vpc: "vpc-stg", cidr: "10.30.0.0/16", name: "acme-staging",
    publicSubnets: ["subnet-stg-a"], // the ECS host (../mock.ts)
    namedPrivateSubnets: ["subnet-stg-private-a", "subnet-stg-private-b"], // "private", but routed to igw-stg: acme-staging-pg
    igw: "igw-stg", routeTables: { public: "rtb-stg-public" },
  },
  peering: { id: "pcx-0acme0stg0prod001", requester: "vpc-stg", accepter: "vpc-prod" }, // staging reaches production's /16
  exposedDb: { id: "acme-staging-pg", securityGroup: "sg-stg-db", port: 5432, openTo: "0.0.0.0/0", subnet: "subnet-stg-private-a" },
  unattachedEip: { allocationId: "eipalloc-0acme0old0ip0001", ip: "203.0.113.77" }, // "not attached — billed hourly"
  vpn: { id: "vpn-0acme0office00001", name: "acme-office", tunnels: ["UP", "DOWN"] }, // one tunnel down: a warning
  transitGatewayAttachment: { id: "tgw-attach-0acme0prod0001", tgw: "tgw-0acme0shared0001", vpc: "vpc-prod" },
  flowLogGroup: "/acme/vpc/flow-logs",
};

// Security groups beyond the ECS ones in ../mock.ts (EXISTING.securityGroups): default groups, and one nobody uses.
export const SECURITY_GROUPS = {
  defaults: { production: "sg-prod-default", staging: "sg-stg-default" },
  unused: { id: "sg-old-bastion", name: "old-bastion", vpc: "vpc-prod" }, // 0 ENIs, not referenced: idle
  bastion: { id: "sg-prod-bastion", name: "bastion", vpc: "vpc-prod" }, // 22/tcp from the office /32 (EC2.bastion)
  officeCidr: "198.51.100.10/32",
};

// Cloud Map (ECS service discovery): production services register in acme.internal. billing is registered but has
// no instances (its ECS service runs without the registry): stopped "no instances registered".
const nsId = "ns-acme0internal001";
const srv = (id: string, name: string) => ({ id, name, arn: arn("servicediscovery", `service/${id}`), fqdn: `${name}.acme.internal` });
export const CLOUDMAP = {
  namespace: { id: nsId, name: "acme.internal", type: "DNS_PRIVATE", hostedZoneId: "Z0ACMEINTERNAL1", arn: arn("servicediscovery", `namespace/${nsId}`), vpc: "vpc-prod" },
  services: { api: srv("srv-acme0api000001", "api"), worker: srv("srv-acme0worker001", "worker"), billing: srv("srv-acme0billing01", "billing") },
};

// EBS: the staging host's root volume, and a forgotten 200 GiB build cache (unattached: billed per GB).
export const EBS = {
  stagingRoot: { id: "vol-0acme0stg0root001", name: "acme-staging-root", sizeGb: 30, instance: "i-0a1b2c3d4e5f67890" },
  unattached: { id: "vol-0acme0old0cache01", name: "acme-old-build-cache", sizeGb: 200 },
};

// IAM roles (global). Task roles per ECS service, one execution role, the host's instance profile, the Lambda role,
// an AWS service-linked role (hidden), a role nobody has used (never used → idle) and a partner role whose trust
// policy lets another account in without an external id (warning).
const role = (name: string, path = "/") => ({ name, arn: globalArn("iam", `role${path}${name}`) });
export const IAM_ROLES = {
  taskExecution: role("acme-ecs-task-execution"),
  tasks: { api: role("acme-production-api-task"), worker: role("acme-production-worker-task"), billing: role("acme-production-billing-task"), console: role("acme-deployment-console") },
  ecsInstance: { ...role("acme-ecs-instance"), instanceProfile: globalArn("iam", "instance-profile/acme-ecs-instance") },
  lambda: role("acme-lambda-exec"),
  codebuild: role("acme-codebuild", "/service-role/"),
  serviceLinked: role("AWSServiceRoleForECS", "/aws-service-role/ecs.amazonaws.com/"),
  neverUsed: role("acme-old-deployer"),
  partner: { ...role("acme-partner-readonly"), trustedAccount: "210987654321" },
};

// KMS. The application key is multi-Region (replica in eu-west-1); the legacy key is scheduled for deletion and still
// encrypts acme-old-backups (a warning there); AWS-managed keys are hidden.
const mrk = "mrk-0acme1234567890abcdef12345678";
export const KMS_KEYS = {
  app: { id: mrk, alias: "alias/acme-production", arn: arn("kms", `key/${mrk}`), aliasArn: arn("kms", "alias/acme-production") },
  appReplica: { id: mrk, region: EU_REGION, arn: arn("kms", `key/${mrk}`, EU_REGION) },
  legacy: { id: "0acme0ab-1111-4c2d-8e3f-000000000002", alias: "alias/acme-legacy-backups", arn: arn("kms", "key/0acme0ab-1111-4c2d-8e3f-000000000002"), deletionInDays: 5 },
  awsManaged: { rds: arn("kms", "alias/aws/rds"), secretsManager: arn("kms", "alias/aws/secretsmanager"), sqs: arn("kms", "alias/aws/sqs") },
};

// ACM. A wildcard on the ALB, the CloudFront certificate (us-east-1), one that failed validation and nobody uses
// ("validation failed — unused, safe to delete"), and the eu-west-1 one.
const cert = (id: string, domain: string, region: string = REGION) => ({ id, domain, arn: arn("acm", `certificate/${id}`, region) });
export const ACM_CERTS = {
  alb: cert("0acme0c1-aaaa-4bbb-8ccc-000000000001", "*.acme.dev"),
  cloudfront: cert("0acme0c1-aaaa-4bbb-8ccc-000000000002", "www.acme.example"),
  failed: cert("0acme0c1-aaaa-4bbb-8ccc-000000000003", "old.acme.example"),
  eu: cert("0acme0c1-aaaa-4bbb-8ccc-000000000004", "eu.acme.example", EU_REGION),
};

// CloudWatch Logs: ECS groups follow ../mock.ts (logGroup()), Lambda ones the AWS convention. Container Insights and
// vended groups are hidden.
export const LOG_GROUPS = {
  ecs: (env: string, service: string) => `/ecs/acme-${env}/${service}`,
  lambda: (fn: string) => `/aws/lambda/${fn}`,
  rds: "/aws/rds/instance/acme-production-pg/postgresql",
  codebuild: "/aws/codebuild/acme-billing-build",
  containerInsights: "/aws/ecs/containerinsights/acme-production/performance",
  cloudtrail: "/acme/cloudtrail",
  arn: (name: string, region: string = REGION) => arn("logs", `log-group:${name}`, region),
};

// CloudWatch alarms. Target tracking on api created the AlarmHigh/AlarmLow pair; AlarmLow sits in ALARM whenever load
// is low and must NOT warn api. The database CPU alarm is in ALARM and warns acme-production-pg.
const policyId = "0acme0sp-2222-4333-8444-000000000001";
export const ALARMS = {
  scalingPolicyArn: `arn:aws:autoscaling:${REGION}:${ACCT}:scalingPolicy:${policyId}:resource/ecs/service/acme-production/api:policyName/acme-api-cpu-target`,
  apiHigh: { name: "TargetTracking-service/acme-production/api-AlarmHigh-0acme0a1-0000-4000-8000-000000000001", state: "OK" },
  apiLow: { name: "TargetTracking-service/acme-production/api-AlarmLow-0acme0a1-0000-4000-8000-000000000002", state: "ALARM" },
  dbCpu: { name: "acme-production-pg-cpu-high", state: "ALARM", dbInstance: "acme-production-pg" },
  ordersDlq: { name: "acme-production-orders-dlq-not-empty", state: "OK", queue: "acme-production-orders-dlq" }, // → SNS acme-alarms
  arn: (name: string) => arn("cloudwatch", `alarm:${name}`),
};

// CloudWatch Synthetics: the checkout canary's last run failed.
export const CANARY = { name: "acme-checkout-canary", arn: arn("synthetics", "canary:acme-checkout-canary"), url: "https://www.acme.example/checkout", lastRun: "FAILED" };

// Route 53 health check on the API (all checkers report success).
export const HEALTH_CHECK = { id: "4f9a1c2e-0a0e-4e11-9c00-0000000000a1", fqdn: "api.acme.example", arn: "arn:aws:route53:::healthcheck/4f9a1c2e-0a0e-4e11-9c00-0000000000a1" };

// CloudTrail: one multi-region trail to the logs bucket and a log group.
export const TRAIL = { name: "acme-trail", arn: arn("cloudtrail", "trail/acme-trail"), bucket: "acme-logs", logGroup: "/acme/cloudtrail" };

// ECR. ECS images are <registry>/<repository>:<tag>; caddy and redis come from Docker Hub. acme/legacy-admin has had no
// pull or push in months (idle).
export const ECR_REGISTRY = `${ACCT}.dkr.ecr.${REGION}.amazonaws.com`;
const repo = (name: string) => ({ name, arn: arn("ecr", `repository/${name}`), uri: `${ECR_REGISTRY}/${name}` });
export const ECR_REPOS = {
  storefrontApi: repo("acme/storefront-api"), // ECS api
  jobs: repo("acme/jobs"), // ECS worker
  billing: repo("acme/billing"), // ECS billing
  deploymentConsole: repo("acme/deployment-console"), // ECS deployment-console
  legacyAdmin: repo("acme/legacy-admin"), // idle
};
export const ECR_REPO_OF: Record<string, string> = { api: "acme/storefront-api", worker: "acme/jobs", billing: "acme/billing", "deployment-console": "acme/deployment-console" };
export const ecrImage = (repository: string, tag: string) => `${ECR_REGISTRY}/${repository}:${tag}`;

// Delivery. Billing releases through CodePipeline (GitHub → CodeBuild → ECS deploy); the legacy admin deploys with
// CodeDeploy; CloudFormation manages the network and the data stack.
export const CODEBUILD = { billing: { name: "acme-billing-build", arn: arn("codebuild", "project/acme-billing-build"), lastBuild: "SUCCEEDED" } };
export const CODEPIPELINE = { billing: { name: "acme-billing-release", arn: arn("codepipeline", "acme-billing-release"), deploys: { cluster: "acme-production", service: "billing" } } };
export const CODEDEPLOY = { legacyAdmin: { app: "acme-legacy-admin", group: "acme-legacy-admin-prod", arn: arn("codedeploy", "deploymentgroup:acme-legacy-admin/acme-legacy-admin-prod"), last: "Failed" } };
export const CFN = {
  network: { name: "acme-network", id: "0acme0f1-3333-4444-8555-000000000001", arn: arn("cloudformation", "stack/acme-network/0acme0f1-3333-4444-8555-000000000001") },
  data: { name: "acme-production-data", id: "0acme0f1-3333-4444-8555-000000000002", arn: arn("cloudformation", "stack/acme-production-data/0acme0f1-3333-4444-8555-000000000002") },
};

// Databases beyond RDS instances. Aurora acme-analytics (members -1 and -2) is the primary of a global database whose
// secondary runs in eu-west-1; a proxy fronts acme-production-pg; sessions moved to ElastiCache Serverless.
export const AURORA = {
  cluster: {
    id: "acme-analytics", arn: arn("rds", "cluster:acme-analytics"), engine: "aurora-postgresql", members: ["acme-analytics-1", "acme-analytics-2"],
    endpoint: `acme-analytics.cluster-c0example.${REGION}.rds.amazonaws.com`, readerEndpoint: `acme-analytics.cluster-ro-c0example.${REGION}.rds.amazonaws.com`,
  },
  global: { id: "acme-analytics-global" },
  secondary: { id: "acme-analytics-eu", region: EU_REGION, arn: arn("rds", "cluster:acme-analytics-eu", EU_REGION), members: ["acme-analytics-eu-1"] },
};
export const RDS_PROXY = {
  name: "acme-production-pg-proxy", id: "prx-0acme0proxy000001", arn: arn("rds", "db-proxy:prx-0acme0proxy000001"), target: "acme-production-pg",
  endpoint: `acme-production-pg-proxy.proxy-c0example.${REGION}.rds.amazonaws.com`,
};
export const SERVERLESS_CACHE = {
  name: "acme-sessions-cache", arn: arn("elasticache", "serverlesscache:acme-sessions-cache"),
  endpoint: "acme-sessions-cache-x1y2z3.serverless.use1.cache.amazonaws.com", readerEndpoint: "acme-sessions-cache-x1y2z3.serverless.use1.cache.amazonaws.com",
};
export const MEMORYDB = { name: "acme-ratelimits", arn: arn("memorydb", "cluster/acme-ratelimits"), endpoint: `clustercfg.acme-ratelimits.x1y2z3.memorydb.${REGION}.amazonaws.com` };
export const OPENSEARCH = { name: "acme-search", arn: arn("es", "domain/acme-search"), endpoint: `vpc-acme-search-x1y2z3a4b5.${REGION}.es.amazonaws.com` };
export const REDSHIFT = {
  cluster: { id: "acme-analytics-dw", arn: arn("redshift", "cluster:acme-analytics-dw"), state: "paused" }, // paused: stopped
  workgroup: { name: "acme-adhoc", id: "0acme0b2-4444-4555-8666-000000000001", arn: arn("redshift-serverless", "workgroup/0acme0b2-4444-4555-8666-000000000001") },
};
export const EFS = {
  media: {
    id: "fs-0acme0media000001", name: "acme-production-media", arn: arn("elasticfilesystem", "file-system/fs-0acme0media000001"),
    accessPoint: { id: "fsap-0acme0media00001", arn: arn("elasticfilesystem", "access-point/fsap-0acme0media00001") },
    mountedBy: { cluster: "acme-production", service: "worker" }, // the ECS task definition's EFS volume
  },
};
export const GLUE = {
  job: { name: "acme-nightly-etl", arn: arn("glue", "job/acme-nightly-etl") }, // script in acme-data-lake, last run succeeded
  crawler: { name: "acme-orders-crawler", arn: arn("glue", "crawler/acme-orders-crawler") },
  database: { name: "acme_lake", arn: arn("glue", "database/acme_lake") }, // no first-class reader: the catch-all shows it
  lakeBucket: "acme-data-lake",
};
export const ATHENA = {
  primary: { name: "primary", arn: arn("athena", "workgroup/primary") }, // no output location: hidden
  analysts: { name: "acme-analysts", arn: arn("athena", "workgroup/acme-analysts"), output: "s3://acme-data-lake/athena-results/" },
};

// Messaging and integration.
export const MSK = { name: "acme-events", id: "0acme0c3-5555-4666-8777-000000000001-1", arn: arn("kafka", "cluster/acme-events/0acme0c3-5555-4666-8777-000000000001-1"), brokers: [`b-1.acme-events.x1y2z3.c2.kafka.${REGION}.amazonaws.com:9098`, `b-2.acme-events.x1y2z3.c2.kafka.${REGION}.amazonaws.com:9098`] };
export const MQ = { name: "acme-legacy-mq", id: "b-0acme0d4-6666-4777-8888-000000000001", arn: arn("mq", "broker:acme-legacy-mq:b-0acme0d4-6666-4777-8888-000000000001"), host: `b-0acme0d4-6666-4777-8888-000000000001-1.mq.${REGION}.amazonaws.com` };
export const FIREHOSE = { clickstream: { name: "acme-clickstream-to-s3", arn: arn("firehose", "deliverystream/acme-clickstream-to-s3"), source: "acme-production-clickstream", bucket: "acme-data-lake" } };
export const SES = { domain: { identity: "acme.example", arn: arn("ses", "identity/acme.example") }, configurationSet: "acme-transactional" };
export const SCHEDULES = {
  dailyDigest: { group: "default", name: "acme-daily-digest", arn: arn("scheduler", "schedule/default/acme-daily-digest"), expression: "cron(0 7 * * ? *)", target: "acme-production-email-sender" },
  stagingCleanup: { group: "default", name: "acme-staging-cleanup", arn: arn("scheduler", "schedule/default/acme-staging-cleanup"), expression: "rate(1 day)", state: "DISABLED" },
};
export const PIPES = { orders: { name: "acme-orders-to-checkout", arn: arn("pipes", "pipe/acme-orders-to-checkout"), source: "acme-production-orders", target: "acme-production-checkout" } };
export const BATCH = {
  environment: { name: "acme-batch-spot", arn: arn("batch", "compute-environment/acme-batch-spot") },
  queue: { name: "acme-reports", arn: arn("batch", "job-queue/acme-reports") },
};

// Edge and protection.
export const WAF = {
  alb: { name: "acme-production-web", id: "0acme0e5-7777-4888-8999-000000000001", scope: "REGIONAL", arn: arn("wafv2", "regional/webacl/acme-production-web/0acme0e5-7777-4888-8999-000000000001") },
  cloudfront: { name: "acme-cloudfront-web", id: "0acme0e5-7777-4888-8999-000000000002", scope: "CLOUDFRONT", arn: arn("wafv2", "global/webacl/acme-cloudfront-web/0acme0e5-7777-4888-8999-000000000002") },
};
export const COGNITO = { customers: { name: "acme-customers", id: `${REGION}_AcMe12345`, arn: arn("cognito-idp", `userpool/${REGION}_AcMe12345`), domain: "auth.acme.example" } };
export const BACKUP = {
  plan: { name: "acme-daily", id: "0acme0f6-8888-4999-8aaa-000000000001", arn: arn("backup", "backup-plan:0acme0f6-8888-4999-8aaa-000000000001"), protects: ["acme-production-pg", "acme-production-carts"] },
  vault: { name: "acme-backups", arn: arn("backup", "backup-vault:acme-backups") },
};
export const GLOBAL_ACCELERATOR = { name: "acme-global", id: "0acme0a7-9999-4aaa-8bbb-000000000001", arn: globalArn("globalaccelerator", "accelerator/0acme0a7-9999-4aaa-8bbb-000000000001"), dns: "a0acme0global.awsglobalaccelerator.com", ips: ["198.51.100.40", "198.51.100.41"] };
export const CLASSIC_ELB = { name: "acme-legacy-clb", arn: arn("elasticloadbalancing", "loadbalancer/acme-legacy-clb"), dns: `acme-legacy-clb-1234567890.${REGION}.elb.amazonaws.com`, instance: "i-0acmelegacy00002" };
export const TRANSFER = { sftp: { id: "s-0acme0sftp000000001", name: "acme-partner-sftp", arn: arn("transfer", "server/s-0acme0sftp000000001"), bucket: "acme-production-uploads" } };
export const APPSYNC = { catalog: { id: "acme0catalog0gql0000000001", name: "acme-catalog-graphql", arn: arn("appsync", "apis/acme0catalog0gql0000000001"), table: "acme-production-carts" } };
export const AMPLIFY = { marketing: { id: "d0acme0mkt0site", name: "acme-marketing-site", arn: arn("amplify", "apps/d0acme0mkt0site"), branch: "main", domain: "main.d0acme0mkt0site.amplifyapp.com" } };
export const LIGHTSAIL = {
  instance: { name: "acme-wordpress", arn: arn("lightsail", "Instance/0acme0b8-aaaa-4bbb-8ccc-000000000001") },
  container: { name: "acme-status-page", arn: arn("lightsail", "ContainerService/0acme0b8-aaaa-4bbb-8ccc-000000000002") },
  database: { name: "acme-wp-db", arn: arn("lightsail", "RelationalDatabase/0acme0b8-aaaa-4bbb-8ccc-000000000003") },
};

// The long tail (wave C): machine learning, file systems and network services.
export const SAGEMAKER = {
  endpoint: { name: "acme-recs", arn: arn("sagemaker", "endpoint/acme-recs"), status: "InService" },
  notebook: { name: "acme-notebook", arn: arn("sagemaker", "notebook-instance/acme-notebook"), status: "Stopped" },
  model: { name: "acme-recs-model", arn: arn("sagemaker", "model/acme-recs-model") }, // left to the catch-all
};
export const BEDROCK = {
  agent: { id: "ACMEAGENT1", name: "acme-support-agent", arn: arn("bedrock", "agent/ACMEAGENT1"), status: "PREPARED" },
  knowledgeBase: { id: "ACMEKB0001", name: "acme-docs-kb", arn: arn("bedrock", "knowledge-base/ACMEKB0001"), bucket: "acme-production-assets" },
  provisioned: { id: "acme0pt0claude01", name: "acme-pt-claude", arn: arn("bedrock", "provisioned-model/acme0pt0claude01") },
};
export const FSX = { shared: { id: "fs-0acme0shared0fsx01", name: "acme-shared-fsx", arn: arn("fsx", "file-system/fs-0acme0shared0fsx01"), dns: `fs-0acme0shared0fsx01.fsx.${REGION}.amazonaws.com` } };
export const NETWORK_FIREWALL = { egress: { name: "acme-egress-fw", arn: arn("network-firewall", "firewall/acme-egress-fw"), policy: "acme-egress-policy", vpc: "vpc-prod" } };
export const RESOLVER = {
  outbound: { id: "rslvr-out-0acme0outbound01", name: "acme-outbound-resolver", arn: arn("route53resolver", "resolver-endpoint/rslvr-out-0acme0outbound01"), ips: ["10.20.8.10", "10.20.9.10"] },
  rule: { id: "rslvr-rr-0acme0corp0rule01", name: "corp-acme-internal", domain: "corp.acme.internal", arn: arn("route53resolver", "resolver-rule/rslvr-rr-0acme0corp0rule01"), targets: ["10.99.0.10", "10.99.0.11"] },
};
export const LATTICE = {
  network: { id: "sn-0acme0mesh00000001", name: "acme-mesh", arn: arn("vpc-lattice", "servicenetwork/sn-0acme0mesh00000001") },
  service: { id: "svc-0acme0orders000001", name: "acme-orders-svc", arn: arn("vpc-lattice", "service/svc-0acme0orders000001"), dns: `acme-orders-svc-0acme0orders000001.7d67968.vpc-lattice-svcs.${REGION}.on.aws`, target: "acme-production" }, // → the Acme ALB
};

// Generic resources only the catch-all lists (Resource Explorer rows): the Glue database and SageMaker model above,
// plus sub-objects that must be dropped (counted in hiddenTypes) and an IAM user shown as a table row.
export const CATCHALL = {
  iamUser: { name: "acme-ci", arn: globalArn("iam", "user/acme-ci") },
  networkInterface: arn("ec2", "network-interface/eni-0acme0noise000001"), // dropped (sub-object)
  taskDefinition: arn("ecs", "task-definition/api-production:120"), // dropped (sub-object)
};

// ---------- eu-west-1: the second region ----------
// A small production estate whose ECS cluster name collides with the home one on purpose (the env becomes
// "production-eu-west-1"): api (2 tasks) and worker (1) on Fargate, one private RDS with its own group, no cache. Plus
// the regional halves of the home estate: the Aurora secondary, the KMS replica, an ACM certificate and the S3 replica.
const euArn = (svc: string, rest: string) => arn(svc, rest, EU_REGION);
export const EU = {
  region: EU_REGION,
  cluster: "acme-production",
  services: [{ name: "api", tasks: 2 }, { name: "worker", tasks: 1 }],
  rds: { id: "acme-production-eu-pg", arn: euArn("rds", "db:acme-production-eu-pg"), host: `acme-production-eu-pg.c0example.${EU_REGION}.rds.amazonaws.com`, securityGroup: "sg-eu-db" },
  vpc: { id: "vpc-eu-prod", cidr: "10.40.0.0/16", subnets: ["subnet-eu-prod-a", "subnet-eu-prod-b"] },
  securityGroups: { api: "sg-eu-api", worker: "sg-eu-worker", db: "sg-eu-db" },
  logGroup: (service: string) => `/ecs/acme-production-eu/${service}`,
  auroraSecondary: AURORA.secondary,
  kmsReplica: KMS_KEYS.appReplica,
  certificate: ACM_CERTS.eu,
  s3Replica: { name: "acme-production-assets-eu", arn: "arn:aws:s3:::acme-production-assets-eu", domain: `acme-production-assets-eu.s3.${EU_REGION}.amazonaws.com` }, // replication target of acme-production-assets
};
