// Development-only sample data for the cloud map: the simulated "Acme" estate (same names as
// src/lib/server/providers/mock-names.ts) as an InventoryView, plus a synthetic large account for performance checks.
// Loaded lazily by the map page only in `next dev`, and only while GET /api/inventory is missing (404) — or when the
// URL asks for it with ?fixture=acme|big. Production builds never fetch this module.
import type { Category, Edge, EdgeKind, Health, InventoryView, Prop, Resource, ResourceKind, Routing } from "../../lib/inventory/types.ts";

const ACCT = "123456789012";
const REGION = "us-east-1";
const DAY = 86_400_000;
const arn = (svc: string, rest: string, region = REGION) => `arn:aws:${svc}:${region}:${ACCT}:${rest}`;
const p = (label: string, value: string, mono = false): Prop => ({ label, value, mono });

interface Spec {
  key: string;
  kind: ResourceKind;
  name: string;
  env?: string;
  envWhy?: string;
  provider: string;
  health?: Health;
  healthReason?: string;
  props?: Prop[];
  tags?: Record<string, string>;
  endpoints?: string[];
  aliases?: string[];
  idle?: string;
  notes?: number;
  region?: string;
  consoleUrl?: string;
  // Coverage fields (D.4), so the map's layers, folding, badges and table have something to show.
  parent?: string;
  vpcId?: string;
  facts?: Resource["facts"];
  hidden?: boolean;
  slim?: boolean;
  source?: Resource["source"];
  category?: Category;
  service?: string;
  resourceType?: string;
  tagsUnread?: boolean;
  enrichment?: Resource["enrichment"];
  account?: string;
}

export function acmeFixture(now = Date.now()): InventoryView {
  const res: Resource[] = [];
  const add = (s: Spec) => {
    res.push({
      key: s.key,
      kind: s.kind,
      provider: s.provider,
      name: s.name,
      region: s.region ?? REGION,
      tags: s.tags ?? (s.env ? { Environment: s.env } : {}),
      health: s.health ?? "ok",
      healthReason: s.healthReason,
      props: s.props ?? [],
      endpoints: s.endpoints,
      aliases: s.aliases,
      env: s.env,
      envWhy: s.envWhy ?? (s.env ? `tag Environment=${s.env}` : undefined),
      idle: s.idle ? { why: s.idle, since: now - 40 * DAY } : undefined,
      notes: s.notes,
      consoleUrl: s.consoleUrl ?? `https://${REGION}.console.aws.amazon.com/`,
      createdAt: now - 400 * DAY,
      lastModified: now - 3 * DAY,
      ...(s.parent ? { parent: s.parent } : {}),
      ...(s.vpcId ? { vpcId: s.vpcId } : {}),
      ...(s.facts ? { facts: s.facts } : {}),
      ...(s.hidden ? { hidden: true } : {}),
      ...(s.slim ? { slim: true, props: [] } : {}),
      ...(s.source ? { source: s.source } : {}),
      ...(s.category ? { category: s.category } : {}),
      ...(s.service ? { service: s.service } : {}),
      ...(s.resourceType ? { resourceType: s.resourceType } : {}),
      ...(s.tagsUnread ? { tagsUnread: true } : {}),
      ...(s.enrichment ? { enrichment: s.enrichment } : {}),
      ...(s.account ? { account: s.account } : {}),
    });
    return s.key;
  };
  const edges: Edge[] = [];
  const link = (from: string, to: string, kind: EdgeKind, label: string | undefined, evidence: string, confidence: Edge["confidence"] = "config", routing?: Routing) =>
    edges.push({ id: `${from}->${to}:${kind}`, from, to, kind, label, evidence: [evidence], confidence, ...(routing ? { routing } : {}) });

  // ---- edge & DNS ----
  const zone = add({ key: "arn:aws:route53:::hostedzone/Z0ACMEEXAMPLE", kind: "route53-zone", name: "acme.example", provider: "route53", region: "global", props: [p("Records", "14"), p("Type", "public")], endpoints: ["acme.example"] });
  const cf = add({ key: "cloudflare:zone/cf0acme1shop2zone3", kind: "cloudflare-zone", name: "acme-shop.com", provider: "cloudflare", region: "global", props: [p("Plan", "Pro"), p("Records", "6")], endpoints: ["acme-shop.com"] });
  const cdn = add({ key: `arn:aws:cloudfront::${ACCT}:distribution/E2ACME1SHOP`, kind: "cloudfront", name: "www.acme.example", env: "production", provider: "cloudfront", region: "global", props: [p("Domain", "d1a2b3c4shop.cloudfront.net", true), p("Origins", "2"), p("Price class", "100")], endpoints: ["d1a2b3c4shop.cloudfront.net", "www.acme.example", "shop.acme-shop.com"], notes: 1 });
  const cdnStg = add({ key: `arn:aws:cloudfront::${ACCT}:distribution/E3ACMESTG`, kind: "cloudfront", name: "staging.acme.example", env: "staging", provider: "cloudfront", region: "global", props: [p("Domain", "d9z8y7stg.cloudfront.net", true)], endpoints: ["d9z8y7stg.cloudfront.net", "staging.acme.example"] });
  const apiPub = add({ key: `arn:aws:apigateway:${REGION}::/apis/a1b2c3d4e5`, kind: "apigateway", name: "acme-production-public-api", env: "production", provider: "apigateway", props: [p("Type", "HTTP"), p("Routes", "7"), p("Custom domain", "api-public.acme.example", true)], endpoints: ["a1b2c3d4e5.execute-api.us-east-1.amazonaws.com", "api-public.acme.example"] });
  const apiPartners = add({ key: `arn:aws:apigateway:${REGION}::/restapis/p9q8r7s6t5`, kind: "apigateway", name: "acme-staging-partners", env: "staging", provider: "apigateway", props: [p("Type", "REST"), p("Stage", "v1")] });
  const alb = add({ key: "elb:acme-production", kind: "loadbalancer", name: "acme-production", env: "production", envWhy: "ECS cluster acme-production", provider: "ecs", props: [p("Scheme", "internet-facing"), p("Listeners", "80, 443"), p("DNS", "acme-production-1839406127.us-east-1.elb.amazonaws.com", true)] });

  // ---- compute ----
  const ecs = (env: string, svc: string, extra: Partial<Spec> = {}) =>
    add({ key: `ecs:service/acme-${env}/${svc}`, kind: "ecs-service", name: svc, env, envWhy: `ECS cluster acme-${env}`, provider: "ecs", props: [p("Tasks", "2 / 2"), p("Launch type", env === "production" ? "FARGATE" : "EC2")], ...extra });
  const api = ecs("production", "api", { notes: 2 });
  const worker = ecs("production", "worker");
  const billing = ecs("production", "billing");
  const consoleSvc = ecs("production", "deployment-console", { props: [p("Tasks", "1 / 1"), p("Launch type", "FARGATE")] });
  const sApi = ecs("staging", "api");
  const sWorker = ecs("staging", "worker");
  const sBilling = ecs("staging", "billing", { health: "warning", healthReason: "1 of 2 tasks unhealthy" });
  const sCaddy = ecs("staging", "caddy", { props: [p("Tasks", "1 / 1"), p("Launch type", "EC2")] });
  const sRedis = ecs("staging", "redis", { props: [p("Tasks", "1 / 1"), p("Launch type", "EC2")] });
  const fn = (name: string, env: string | undefined, runtime: string, extra: Partial<Spec> = {}) =>
    add({ key: arn("lambda", `function:${name}`), kind: "lambda", name, env, provider: "lambda", props: [p("Runtime", runtime), p("Memory", "512 MB"), p("Timeout", "30 s")], aliases: [name], ...extra });
  const thumbStg = fn("acme-staging-thumbnailer", "staging", "nodejs22.x");
  const thumbProd = fn("acme-production-thumbnailer", "production", "nodejs22.x");
  const orderEvents = fn("acme-production-order-events", "production", "nodejs22.x");
  const emailSender = fn("acme-production-email-sender", "production", "python3.13", { health: "warning", healthReason: "3 of the last 50 invocations failed" });
  const nightly = fn("acme-production-nightly-report", "production", "python3.13");
  const publicApi = fn("acme-production-public-api", "production", "nodejs22.x");
  const partners = fn("acme-staging-partners-api", "staging", "nodejs22.x");
  const reserve = fn("acme-production-checkout-reserve", "production", "nodejs22.x", { health: "error", healthReason: "last 3 invocations failed (Task timed out)" });
  const legacyFn = fn("legacy-cron-cleanup", undefined, "nodejs18.x", { health: "warning", healthReason: "runtime nodejs18.x is deprecated", idle: "no invocations in 30 days" });
  const bastion = add({ key: "ec2:i-0acmebastion0001", kind: "ec2-instance", name: "acme-bastion", provider: "ec2", props: [p("Type", "t4g.nano"), p("Public IP", "203.0.113.20", true)], endpoints: ["203.0.113.20"] });
  const legacyBox = add({ key: "ec2:i-0acmelegacy00002", kind: "ec2-instance", name: "acme-legacy-cron", env: "production", provider: "ec2", health: "stopped", healthReason: "stopped 45 days ago", props: [p("Type", "t3.small"), p("State", "stopped")], idle: "stopped for 45 days" });
  const stagingBox = add({ key: "ec2:i-0a1b2c3d4e5f67890", kind: "ec2-instance", name: "acme-staging", env: "staging", envWhy: "ECS cluster acme-staging", provider: "ecs", props: [p("Type", "t3a.small"), p("Role", "ECS container instance")] });
  const eks = add({ key: arn("eks", "cluster/acme-data-platform"), kind: "eks-cluster", name: "acme-data-platform", env: "production", envWhy: "VPC vpc-prod", provider: "eks", props: [p("Version", "1.33"), p("Node groups", "1 (m6i.large × 2)")] });
  const reco = add({ key: "eks:acme-data-platform/ml/Deployment/recommender", kind: "eks-workload", name: "recommender", env: "production", envWhy: "cluster acme-data-platform", provider: "eks", props: [p("Kind", "Deployment"), p("Replicas", "3 / 3"), p("Namespace", "ml")] });
  const features = add({ key: "eks:acme-data-platform/ml/StatefulSet/feature-store", kind: "eks-workload", name: "feature-store", env: "production", envWhy: "cluster acme-data-platform", provider: "eks", props: [p("Kind", "StatefulSet"), p("Replicas", "2 / 2"), p("Namespace", "ml")] });
  const preview = add({ key: arn("apprunner", "service/acme-staging-preview/0f1e2d3c4b5a"), kind: "apprunner", name: "acme-staging-preview", env: "staging", provider: "apprunner", props: [p("Status", "RUNNING"), p("URL", "abcd1234.us-east-1.awsapprunner.com", true)] });
  const beanstalk = add({ key: arn("elasticbeanstalk", "environment/acme-legacy-admin/acme-legacy-admin-prod"), kind: "beanstalk", name: "acme-legacy-admin-prod", env: "production", provider: "beanstalk", health: "warning", healthReason: "environment health Degraded", props: [p("Platform", "Node.js 18"), p("Instances", "1")] });

  // ---- messaging ----
  const q = (name: string, env: string | undefined, extra: Partial<Spec> = {}) =>
    add({ key: arn("sqs", name), kind: "sqs", name, env, provider: "sqs", props: [p("Visible", "0"), p("In flight", "0"), p("Type", "standard")], aliases: [`https://sqs.${REGION}.amazonaws.com/${ACCT}/${name}`, name], ...extra });
  const orders = q("acme-production-orders", "production", { notes: 1 });
  const ordersDlq = q("acme-production-orders-dlq", "production", { health: "warning", healthReason: "DLQ holds 14 messages", props: [p("Visible", "14"), p("In flight", "0"), p("Type", "standard")] });
  const emails = q("acme-production-emails", "production");
  const ordersStg = q("acme-staging-orders", "staging");
  const exportsOld = q("acme-exports-old", undefined, { idle: "no messages sent in 30 days" });
  const topic = (name: string, env: string | undefined) => add({ key: arn("sns", name), kind: "sns", name, env, provider: "sns", props: [p("Subscriptions", "3")] });
  const notif = topic("acme-production-notifications", "production");
  topic("acme-staging-notifications", "staging");
  const alarms = topic("acme-alarms", undefined);
  const defBus = add({ key: arn("events", "event-bus/default"), kind: "eventbridge-bus", name: "default", provider: "eventbridge", props: [p("Rules", "1")] });
  const shopBus = add({ key: arn("events", "event-bus/acme-shop-events"), kind: "eventbridge-bus", name: "acme-shop-events", env: "production", provider: "eventbridge", props: [p("Rules", "1")] });
  const nightlyRule = add({ key: arn("events", "rule/acme-production-nightly-report"), kind: "eventbridge-rule", name: "acme-production-nightly-report", env: "production", provider: "eventbridge", props: [p("Schedule", "cron(0 2 * * ? *)", true), p("State", "ENABLED")] });
  const placedRule = add({ key: arn("events", "rule/acme-shop-events/acme-production-order-placed"), kind: "eventbridge-rule", name: "acme-production-order-placed", env: "production", provider: "eventbridge", props: [p("Pattern", '{"detail-type":["OrderPlaced"]}', true), p("Targets", "2")] });
  const checkout = add({ key: arn("states", "stateMachine:acme-production-checkout"), kind: "stepfunctions", name: "acme-production-checkout", env: "production", provider: "stepfunctions", props: [p("Type", "STANDARD"), p("Executions (24 h)", "1,284")] });
  const clicks = add({ key: arn("kinesis", "stream/acme-production-clickstream"), kind: "kinesis", name: "acme-production-clickstream", env: "production", provider: "kinesis", props: [p("Mode", "ON_DEMAND"), p("Retention", "24 h")] });

  // ---- data ----
  const pg = add({ key: "rds:acme-production-pg", kind: "rds", name: "acme-production-pg", env: "production", provider: "rds", props: [p("Engine", "postgres 16.4"), p("Class", "db.t4g.medium"), p("Multi-AZ", "yes")], notes: 3 });
  const pgStg = add({ key: "rds:acme-staging-pg", kind: "rds", name: "acme-staging-pg", env: "staging", provider: "rds", props: [p("Engine", "postgres 16.4"), p("Class", "db.t4g.small")] });
  const valkey = add({ key: "elasticache:acme-production-valkey", kind: "elasticache", name: "acme-production-valkey", env: "production", provider: "elasticache", props: [p("Engine", "valkey 8.0"), p("Nodes", "2")] });
  const table = (name: string, env: string) => add({ key: arn("dynamodb", `table/${name}`), kind: "dynamodb", name, env, provider: "dynamodb", props: [p("Billing", "PAY_PER_REQUEST"), p("Items", "~48k")], aliases: [name] });
  const sessions = table("acme-production-sessions", "production");
  const carts = table("acme-production-carts", "production");
  const sessionsStg = table("acme-staging-sessions", "staging");

  // ---- storage ----
  const bucket = (name: string, env: string | undefined, extra: Partial<Spec> = {}) =>
    add({ key: `arn:aws:s3:::${name}`, kind: "s3", name, env, provider: "s3", region: REGION, props: [p("Objects", "~12k"), p("Versioning", "enabled")], endpoints: [`${name}.s3.${REGION}.amazonaws.com`], aliases: [name], ...extra });
  const assets = bucket("acme-production-assets", "production");
  const uploads = bucket("acme-production-uploads", "production");
  const uploadsStg = bucket("acme-staging-uploads", "staging");
  const logs = bucket("acme-logs", undefined, { props: [p("Objects", "~2.4M"), p("Lifecycle", "expire after 90 days")] });
  bucket("acme-old-backups", undefined, { idle: "no writes in 90 days", props: [p("Objects", "~310"), p("Size", "84 GB")] });

  // ---- external ----
  const stripe = add({ key: "external:stripe", kind: "external", name: "Stripe", provider: "external", region: "global", props: [p("Host", "api.stripe.com", true)], endpoints: ["api.stripe.com"] });
  const status = add({ key: "external:status-page", kind: "external", name: "status.acme-shop.com", provider: "external", region: "global", props: [p("Host", "acme.statuspage.io", true)] });
  const hook = add({ key: "external:partner-webhook", kind: "external", name: "hooks.partner.example", provider: "external", region: "global", props: [p("Host", "hooks.partner.example", true)] });
  const pager = add({ key: "external:pagerduty", kind: "external", name: "PagerDuty", provider: "external", region: "global", props: [p("Host", "events.pagerduty.com", true)] });

  // ---- edges ----
  link(zone, cdn, "route", "www.acme.example ALIAS", "Route 53 record www.acme.example → d1a2b3c4shop.cloudfront.net");
  link(zone, alb, "route", "api.acme.example (failover primary)", "Route 53 record api.acme.example → ALB acme-production (failover PRIMARY, health check hc-api)", "config", { policy: "failover", role: "primary", setId: "api-primary" });
  link(zone, apiPub, "route", "api-public.acme.example", "Route 53 record api-public.acme.example → API Gateway custom domain");
  link(zone, cdnStg, "route", "staging.acme.example CNAME", "Route 53 record staging.acme.example → d9z8y7stg.cloudfront.net");
  link(zone, bastion, "route", "bastion.acme.example A", "Route 53 record bastion.acme.example → 203.0.113.20");
  link(cf, cdn, "route", "shop.acme-shop.com (proxied)", "Cloudflare record shop.acme-shop.com CNAME d1a2b3c4shop.cloudfront.net");
  link(cf, status, "route", "status.acme-shop.com CNAME", "Cloudflare record status → acme.statuspage.io (not in this account)");
  link(cdn, assets, "route", "default origin (OAC)", "CloudFront origin acme-production-assets.s3.us-east-1.amazonaws.com");
  link(cdn, alb, "route", "/api/* → ALB", "CloudFront behavior /api/* → origin acme-production ALB");
  link(cdn, logs, "writes", "access logs", "CloudFront logging bucket acme-logs");
  link(cdnStg, stagingBox, "route", "origin: staging box (Caddy)", "CloudFront origin ec2-… public DNS of i-0a1b2c3d4e5f67890");
  link(stagingBox, sCaddy, "route", "host port 443", "ECS task placement: caddy runs on this instance");
  link(sCaddy, sApi, "http", "reverse proxy :8080", "security group sg-stg-box allows sg-stg-box on 8080", "allowed");
  link(alb, api, "route", "target group api (HTTP 8080)", "listener rule host api.acme.example → target group api");
  link(alb, consoleSvc, "route", "target group console", "listener rule host console.acme.example → target group");
  link(alb, logs, "writes", "access logs", "ALB attribute access_logs.s3.bucket = acme-logs");
  link(apiPub, publicApi, "invoke", "ANY /{proxy+}", "API Gateway integration → acme-production-public-api");
  link(apiPartners, partners, "invoke", "/v1/*", "API Gateway integration → acme-staging-partners-api");
  link(api, pg, "sql", "postgres:5432", "connection string in DATABASE_URL (host acme-production-pg…)", "mentioned");
  link(worker, pg, "sql", "postgres:5432", "security group sg-prod-db allows sg-prod-worker on 5432", "allowed");
  link(billing, pg, "sql", "postgres:5432", "security group sg-prod-db allows sg-prod-api on 5432", "allowed");
  link(api, valkey, "cache", "valkey:6379", "env REDIS_URL", "mentioned");
  link(api, sessions, "uses", "sessions table", "env SESSIONS_TABLE", "mentioned");
  link(api, orders, "writes", "SendMessage", "env ORDERS_QUEUE_URL", "mentioned");
  link(worker, shopBus, "writes", "PutEvents", "env EVENT_BUS_NAME", "mentioned");
  link(worker, emails, "poll", "ReceiveMessage", "env EMAILS_QUEUE_URL", "mentioned");
  link(billing, stripe, "http", "api.stripe.com:443", "env STRIPE_API_BASE", "mentioned");
  link(sApi, pgStg, "sql", "postgres:5432", "connection string in DATABASE_URL", "mentioned");
  link(sWorker, pgStg, "sql", "postgres:5432", "connection string in DATABASE_URL", "mentioned");
  link(sBilling, pgStg, "sql", "postgres:5432", "security group allows on 5432", "allowed");
  link(sApi, sRedis, "cache", "redis:6379", "env REDIS_URL (service discovery redis.staging.local)", "mentioned");
  link(sApi, sessionsStg, "uses", "sessions table", "env SESSIONS_TABLE", "mentioned");
  link(sApi, ordersStg, "writes", "SendMessage", "env ORDERS_QUEUE_URL", "mentioned");
  link(uploads, thumbProd, "event", "s3:ObjectCreated:*", "bucket notification → acme-production-thumbnailer");
  link(uploadsStg, thumbStg, "event", "s3:ObjectCreated:*", "bucket notification → acme-staging-thumbnailer");
  link(thumbProd, assets, "writes", "PutObject", "IAM role allows s3:PutObject on acme-production-assets/*", "allowed");
  link(orders, orderEvents, "poll", "batch 10", "event source mapping (enabled, batch 10)");
  link(orders, ordersDlq, "uses", "redrive after 5 receives", "redrive policy maxReceiveCount 5");
  link(orderEvents, carts, "writes", "UpdateItem", "IAM role allows dynamodb:UpdateItem on acme-production-carts", "allowed");
  link(orderEvents, notif, "writes", "Publish", "env NOTIFICATIONS_TOPIC_ARN", "mentioned");
  link(notif, emailSender, "event", "subscription (lambda)", "SNS subscription → acme-production-email-sender");
  link(notif, emails, "event", "subscription (sqs)", "SNS subscription → acme-production-emails");
  link(notif, hook, "event", "subscription (https)", "SNS subscription → https://hooks.partner.example/acme");
  link(alarms, pager, "event", "subscription (https)", "SNS subscription → https://events.pagerduty.com/…");
  link(defBus, nightlyRule, "event", "schedule", "rule on the default bus");
  link(shopBus, placedRule, "event", "OrderPlaced", "rule on bus acme-shop-events");
  link(nightlyRule, nightly, "event", "target", "rule target → acme-production-nightly-report");
  link(placedRule, orders, "event", "target", "rule target → acme-production-orders");
  link(placedRule, checkout, "event", "target", "rule target → state machine acme-production-checkout");
  link(checkout, reserve, "invoke", "Reserve stock", "state machine definition: Task arn:…:acme-production-checkout-reserve");
  link(checkout, notif, "writes", "Notify", "state machine definition: sns:publish acme-production-notifications");
  link(nightly, carts, "reads", "Scan", "IAM role allows dynamodb:Scan on acme-production-carts", "allowed");
  link(nightly, logs, "writes", "report CSV", "env REPORT_BUCKET", "mentioned");
  link(publicApi, sessions, "reads", "GetItem", "IAM role allows dynamodb:GetItem", "allowed");
  link(reco, clicks, "poll", "GetRecords", "ConfigMap recommender: STREAM_NAME", "mentioned");
  link(reco, sessions, "reads", "sessions", "ConfigMap recommender: SESSIONS_TABLE", "mentioned");
  link(features, carts, "writes", "carts", "ConfigMap feature-store: CARTS_TABLE", "mentioned");
  link(reco, eks, "uses", "scheduled on", "Kubernetes: deployment ml/recommender");
  link(features, eks, "uses", "scheduled on", "Kubernetes: statefulset ml/feature-store");
  link(beanstalk, pg, "sql", "postgres:5432", "security group sg-prod-db allows sg-legacy-admin on 5432", "allowed");
  link(preview, pgStg, "sql", "postgres:5432", "env DATABASE_URL", "mentioned");
  link(legacyFn, exportsOld, "writes", "SendMessage", "env EXPORT_QUEUE", "mentioned");
  link(bastion, pg, "sql", "postgres:5432", "security group sg-prod-db allows sg-bastion on 5432", "allowed");
  link(bastion, pgStg, "sql", "postgres:5432", "security group allows sg-bastion on 5432", "allowed");
  link(legacyBox, pg, "sql", "postgres:5432", "security group sg-prod-db allows sg-legacy on 5432", "allowed");
  link(reserve, carts, "writes", "reserve items", "IAM role allows dynamodb:UpdateItem", "allowed");


  // ---- coverage (D.4): network, security, observability, generic, remote and vanishing resources ----
  const vpcArn = arn("ec2", "vpc/vpc-prod");
  add({ key: vpcArn, kind: "vpc", name: "acme-production", env: "production", provider: "vpc", props: [p("CIDR", "10.20.0.0/16", true)], aliases: ["vpc-prod"], facts: { cidrs: ["10.20.0.0/16"] } });
  const subA = add({ key: arn("ec2", "subnet/subnet-prod-a"), kind: "subnet", name: "acme-production-private-a", env: "production", provider: "vpc", parent: vpcArn, vpcId: "vpc-prod", props: [p("CIDR", "10.20.1.0/24", true)], facts: { routesToIgw: false } });
  add({ key: arn("ec2", "subnet/subnet-prod-b"), kind: "subnet", name: "acme-production-private-b", env: "production", provider: "vpc", parent: vpcArn, vpcId: "vpc-prod", props: [p("CIDR", "10.20.2.0/24", true)], facts: { routesToIgw: false } });
  const nat = add({ key: arn("ec2", "natgateway/nat-0prod"), kind: "nat-gateway", name: "acme-production-nat-a", env: "production", provider: "vpc", parent: subA, vpcId: "vpc-prod" });
  const sg = add({ key: arn("ec2", "security-group/sg-prod-db"), kind: "security-group", name: "acme-production-db", env: "production", provider: "security-group", vpcId: "vpc-prod", props: [p("Inbound rules", "3")], facts: { openIngress: [], attachments: 2, isDefault: false } });
  add({ key: arn("ec2", "security-group/sg-prod-default"), kind: "security-group", name: "default", env: "production", provider: "security-group", vpcId: "vpc-prod", facts: { isDefault: true, attachments: 4, peerGroups: ["sg-prod-default (self-referencing, 4 members)"] } });
  const proxy = add({ key: arn("rds", "db-proxy:prx-0acme"), kind: "rds-proxy", name: "acme-production-pg-proxy", env: "production", provider: "rds-cluster", vpcId: "vpc-prod", props: [p("Engine family", "POSTGRESQL")] });
  const role = add({ key: `arn:aws:iam::${ACCT}:role/acme-production-api`, kind: "iam-role", name: "acme-production-api", env: "production", provider: "iam", region: "global", props: [p("Trusts", "ecs-tasks.amazonaws.com")], enrichment: { policies: "ok", lastUsed: "denied" } });
  const lg = add({ key: arn("logs", "log-group:/ecs/acme-production/api"), kind: "log-group", name: "/ecs/acme-production/api", env: "production", provider: "logs", props: [p("Retention", "30 days")] });
  const alarm = add({ key: arn("cloudwatch", "alarm:acme-production-api-5xx"), kind: "cloudwatch-alarm", name: "acme-production-api-5xx", env: "production", provider: "alarms", health: "warning", healthReason: "ALARM since 13:40 UTC", facts: { alarmState: "ALARM", scaling: false } });
  add({ key: arn("kms", "key/0acme-aws-rds"), kind: "kms-key", name: "aws/rds", provider: "kms", hidden: true, slim: true });
  add({ key: arn("sagemaker", "endpoint/acme-recs"), kind: "aws-resource", name: "acme-recs", env: "production", provider: "catchall", source: "resource-explorer", category: "compute", service: "SageMaker", resourceType: "sagemaker:endpoint", slim: true, tagsUnread: true });
  add({ key: arn("glue", "database/acme_lake"), kind: "aws-resource", name: "acme_lake", env: "production", provider: "catchall", source: "tagging", category: "data", service: "Glue", resourceType: "glue:database", slim: true });
  const remote = add({ key: "arn:aws:s3:::acme-partner-exports", kind: "aws-resource", name: "acme-partner-exports", provider: "s3", region: "global", source: "reference", category: "storage", service: "S3", resourceType: "s3:bucket", account: "210987654321", health: "unknown", healthReason: "referenced in configuration — not in this account/region (210987654321/global)", facts: { remote: true } });
  const gone = add({ key: arn("sqs", "acme-production-retired"), kind: "sqs", name: "acme-production-retired", env: "production", provider: "sqs", health: "unknown", healthReason: "not seen since 12:58 UTC — confirming", facts: { vanishing: true, lastSeen: now - 25 * 60_000 } });
  const euApi = add({ key: "ecs:service/acme-production/api@eu-west-1", kind: "ecs-service", name: "api", env: "production-eu-west-1", envWhy: "ECS cluster acme-production (eu-west-1)", provider: "ecs", region: "eu-west-1", props: [p("Tasks", "2 / 2"), p("Launch type", "FARGATE")] });
  const euPg = add({ key: "rds:acme-production-pg@eu-west-1", kind: "rds", name: "acme-production-pg", env: "production-eu-west-1", provider: "rds", region: "eu-west-1", props: [p("Engine", "postgres 16.4"), p("Class", "db.t4g.medium")], idle: "no connections in 14 days", facts: { idleEvidence: "confirmed-zero" } });
  link(api, proxy, "sql", "database:5432", "security group sg-prod-db allows sg-prod-api on 5432", "allowed");
  link(proxy, pg, "sql", "postgres:5432", "RDS proxy target group → acme-production-pg");
  link(api, role, "assumes", "task role", "task definition api:42 taskRoleArn");
  link(api, lg, "logs", "awslogs", "task definition api:42 log configuration");
  link(alarm, api, "monitors", "5XX > 1%", "alarm dimensions ServiceName=api");
  link(sg, pg, "protects", "inbound 5432", "attached to acme-production-pg");
  link(subA, nat, "route", "0.0.0.0/0", "route table rtb-prod-private");
  link(nightly, remote, "writes", "partner export", "env EXPORT_BUCKET (arn:aws:s3:::acme-partner-exports)", "mentioned");
  link(worker, gone, "writes", "SendMessage", "env RETIRED_QUEUE_URL", "mentioned");
  link(euApi, euPg, "sql", "postgres:5432", "connection string in DATABASE_URL", "mentioned");
  link(cdn, euApi, "route", "/eu/* → eu api", "CloudFront behavior /eu/*", "config", { policy: "latency" });
  void nat;

  const at = now - 90_000;
  const ok = (id: string, label: string, count: number, ms = 400) => ({ id, label, state: "ok" as const, count, ms, at });
  const count = (prov: string) => res.filter((r) => r.provider === prov).length;
  return {
    region: REGION,
    accountId: ACCT,
    generatedAt: at,
    resources: res,
    edges,
    envs: [
      { id: "production", label: "Production", protected: true, source: "ecs" },
      { id: "staging", label: "Staging", protected: false, source: "ecs" },
      { id: "production-eu-west-1", label: "Production (eu-west-1)", protected: true, source: "ecs" },
    ],
    providers: [
      ok("ecs", "ECS", count("ecs"), 820),
      ok("ec2", "EC2", count("ec2")),
      ok("lambda", "Lambda", count("lambda"), 610),
      ok("sqs", "SQS", count("sqs")),
      ok("sns", "SNS", count("sns")),
      { id: "eventbridge", label: "EventBridge", state: "error", count: count("eventbridge"), error: "ListTargetsByRule was throttled; some rule targets may be missing", ms: 1500, at },
      ok("stepfunctions", "Step Functions", count("stepfunctions")),
      ok("kinesis", "Kinesis", count("kinesis")),
      ok("rds", "RDS", count("rds")),
      ok("elasticache", "ElastiCache", count("elasticache")),
      ok("dynamodb", "DynamoDB", count("dynamodb")),
      ok("s3", "S3", count("s3"), 1100),
      ok("apigateway", "API Gateway", count("apigateway")),
      ok("cloudfront", "CloudFront", count("cloudfront")),
      ok("route53", "Route 53", count("route53")),
      ok("cloudflare", "Cloudflare", count("cloudflare")),
      ok("eks", "EKS", count("eks"), 900),
      ok("apprunner", "App Runner", count("apprunner")),
      ok("beanstalk", "Elastic Beanstalk", count("beanstalk")),
      { id: "autoscaling", label: "EC2 Auto Scaling", state: "denied", count: 0, missing: ["autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeScalingActivities"], at },
      { id: "opensearch", label: "OpenSearch", state: "disabled", count: 0, error: "not enabled in console.config.json (inventory.providers)", at },
      ok("external", "Externals", count("external"), 5),
    ],
    truncated: ["s3: object counts are CloudWatch daily estimates"],
    regions: [REGION, "eu-west-1"],
    homeRegion: REGION,
    completeness: { lastCompleteAt: at, providers: { ok: 20, denied: 1, error: 1, skipped: 0, disabled: 1, partial: 0 }, cappedTypes: [], deniedActions: ["autoscaling:DescribeAutoScalingGroups"], staleProviders: [], unresolvedRefs: 1, enrichmentSkipped: 1 },
  };
}

// Mulberry32: a 32-bit integer PRNG (F56). The old float LCG lost precision past a few thousand draws and the
// generator stopped finding new pairs from about n = 2,500, so ?fixture=big hung.
export function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A synthetic account of `n` resources (≈3 edges each) across three environments, for performance checks.
export function bigFixture(n = 800, now = Date.now()): InventoryView {
  const rand = mulberry32(20260927);
  const kinds: ResourceKind[] = ["lambda", "lambda", "lambda", "sqs", "sqs", "sns", "ecs-service", "ecs-service", "dynamodb", "s3", "s3", "rds", "eventbridge-rule", "apigateway", "loadbalancer", "cloudfront", "ec2-instance", "kinesis", "stepfunctions", "elasticache", "eks-workload", "external"];
  const envs = ["production", "staging", "dev", undefined];
  const healths: Health[] = ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "warning", "error", "stopped"];
  const resources: Resource[] = Array.from({ length: n }, (_, i): Resource => {
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const env = envs[Math.floor(rand() * envs.length)];
    const health = healths[Math.floor(rand() * healths.length)];
    const name = `${env ?? "shared"}-${kind}-${String(i).padStart(4, "0")}`;
    return {
      key: `synthetic:${kind}/${i}`, kind, provider: kind, name, region: i % 5 === 4 ? "eu-west-1" : REGION, tags: env ? { Environment: env } : ({} as Record<string, string>), health,
      healthReason: health === "ok" ? undefined : `synthetic ${health}`, props: [p("Index", String(i))], env, envWhy: env ? `tag Environment=${env}` : undefined,
      idle: rand() < 0.06 ? { why: "no activity in 30 days" } : undefined, notes: rand() < 0.05 ? 1 + Math.floor(rand() * 4) : undefined,
    };
  });
  const edgeKinds: EdgeKind[] = ["route", "invoke", "event", "poll", "sql", "reads", "writes", "uses", "http"];
  const conf: Edge["confidence"][] = ["config", "config", "allowed", "mentioned"];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // At most 20 tries per wanted edge: a tiny or very lopsided set can never hang the page.
  for (let tries = 0; edges.length < n * 3 && tries < n * 60; tries++) {
    const a = Math.floor(rand() * n);
    // Mostly within an environment, like real estates.
    let b = Math.floor(rand() * n);
    for (let t = 0; t < 4 && resources[b].env !== resources[a].env && rand() < 0.8; t++) b = Math.floor(rand() * n);
    if (a === b) continue;
    const kind = edgeKinds[Math.floor(rand() * edgeKinds.length)];
    const id = `${resources[a].key}->${resources[b].key}:${kind}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, from: resources[a].key, to: resources[b].key, kind, evidence: ["synthetic"], confidence: conf[Math.floor(rand() * conf.length)] });
  }
  return {
    region: REGION, accountId: ACCT, generatedAt: now - 60_000, resources, edges, regions: [REGION, "eu-west-1"], homeRegion: REGION,
    envs: [
      { id: "production", label: "Production", protected: true, source: "tags" },
      { id: "staging", label: "Staging", protected: false, source: "tags" },
      { id: "dev", label: "Dev", protected: false, source: "tags" },
    ],
    providers: [{ id: "synthetic", label: "Synthetic", state: "ok", count: n, at: now, regions: [{ region: REGION, state: "ok", count: n, at: now }] }],
    completeness: { lastCompleteAt: now - 60_000, providers: { ok: 1, denied: 0, error: 0, skipped: 0, disabled: 0, partial: 0 }, cappedTypes: [], deniedActions: [], staleProviders: [], unresolvedRefs: 0, enrichmentSkipped: 0 },
  };
}
