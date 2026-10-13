// Mock Cloud + CI for local dev, UI work, demos and load testing (CONSOLE_SOURCE=mock). Deterministic: everything
// derives from hashes of names and the clock, so logs and history are stable across reloads without storing anything.
// Rollouts, stop/start and host/database power are simulated as time-based state machines. Hosts the console launches
// join their ECS cluster 90 s after launch (R23), env files carry S3-style ETags and secrets versions (R05).
//
// The account belongs to "Acme", a fictional online shop. Every name, host, id and address below is made up
// (the account id is AWS's documentation placeholder and the public IP is from the TEST-NET-3 range).
// It spans two regions (MOCK_REGIONS), each an "estate" with its own state: us-east-1 is the Acme shop below;
// eu-west-1 is a small production estate whose cluster is also called "acme-production" (discovery has to tell the
// two apart). Any other region is empty. Estates live on globalThis, like the Clouds that read them.
import { createHash } from "node:crypto";
import {
  ECS_DIMENSION, ecrTarget, ENV_FILE_CHANGED, healthOf, scalableTargetsOf, SECRET_CHANGED,
  type LbConfig, type SdkScalableTarget, type SdkScalingPolicy,
} from "../aws-mapping.ts";
import { hostsFromEnv, parseImageRef, shaFromTag } from "../discover.ts";
import { jsonKeyValue, parseSecretRef, withJsonKey, type SecretRef } from "../envvars.ts";
import { summarize } from "../junit.ts";
import { periodFor } from "../metric-specs.ts";
import {
  AURORA, CLOUDMAP, DYNAMO, ECR_REPO_OF, EFS, EU, EU_REGION, EVENTS, IAM_ROLES, KMS_KEYS, MEMORYDB, MOCK_REGIONS, NETWORK, OPENSEARCH, S3 as MOCK_S3, SERVERLESS_CACHE, SNS, SQS,
  STANDALONE_ALB,
} from "./providers/mock-names.ts";
import type {
  CiJob, CiRun, CommitInfo, InsightsResult, ProbeResult, RawBox, RawCache, RawDb, RawDeployment, RawEvent, RawLbTarget, RawRevision, RawSecurityGroup, RawTask,
  RawService, RawTaskDef,
} from "../types.ts";
import { HttpError } from "./errors.ts";
import type { Ci, Cloud, MetricSpec } from "./sources.ts";

// ---------- the simulated AWS account ----------
// Discovery reads this exactly like a real account: two clusters (staging on one ECS-on-EC2 host with host
// networking and Caddy in front, production on Fargate behind an ALB), tags where a team would put them, and
// security groups and connection strings that let connections be inferred.
type EnvName = string;
const ACCT = "123456789012";
const REGION = "us-east-1";
const ecrOf = (region: string) => `${ACCT}.dkr.ecr.${region}.amazonaws.com`;
const STAGING_BRANCH = "staging";
const PROD_BRANCH = "main";
const BRANCHES = [STAGING_BRANCH, PROD_BRANCH];
type ClusterSpec = { env: EnvName; branch: string; tagPrefix: string; ec2: boolean };
const CLUSTERS: Record<string, ClusterSpec> = {
  "acme-staging": { env: "staging", branch: STAGING_BRANCH, tagPrefix: "staging-", ec2: true },
  "acme-production": { env: "production", branch: PROD_BRANCH, tagPrefix: "production-", ec2: false },
};
// eu-west-1's simulated env name (log groups /ecs/acme-production-eu/<service>, families <service>-production-eu).
const EU_ENV: EnvName = "production-eu";
const DEMO: { ecs: string; name?: string; repo?: string; envs: EnvName[]; healthcheck?: Partial<Record<EnvName, string>>; migrations?: boolean }[] = [
  { ecs: "api", name: "Storefront API", repo: "acme/storefront-api", envs: ["staging", "production"], healthcheck: { staging: "https://api.staging.acme.dev/ready" }, migrations: true },
  { ecs: "worker", name: "Jobs", repo: "acme/jobs", envs: ["staging", "production"], healthcheck: { staging: "https://jobs.staging.acme.dev/ready" } },
  { ecs: "billing", name: "Billing", repo: "acme/billing", envs: ["staging", "production"], healthcheck: { staging: "https://billing.staging.acme.dev/ready" }, migrations: true },
  { ecs: "caddy", name: "Caddy", envs: ["staging"] },
  { ecs: "redis", name: "Redis", envs: ["staging"] },
  { ecs: "deployment-console", name: "Deployment Console", repo: "acme/deployment-console", envs: ["production"] },
];
const logGroup = (env: EnvName, service: string) => `/ecs/acme-${env}/${service}`;
const taskFamily = (env: EnvName, service: string) => `${service}-${env}`;
const PROD_SG: Record<string, string> = { api: "sg-prod-api", worker: "sg-prod-worker", billing: "sg-prod-billing", "deployment-console": "sg-prod-console" };
const VALKEY_HOST = "master.acme-production-valkey.x1y2z3.use1.cache.amazonaws.com";
const dbHost = (id: string, region: string = REGION) => `${id}.c0example.${region}.rds.amazonaws.com`;
const BOX_ID = "i-0a1b2c3d4e5f67890";
const ALB_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/acme-production/5f2c1a9d3e7b4c60`;
// Variables as a team would set them: connection strings in plain environment (discovery infers edges from their
// hostnames), keys in SSM / Secrets Manager, and the rest in an S3 env file on staging. Values are fake.
type MEnv = { environment: { name: string; value: string }[]; secrets: { name: string; valueFrom: string }[]; files: string[] };
const smArn = (name: string) => `arn:aws:secretsmanager:${REGION}:${ACCT}:secret:${name}-Ab12Cd`;
// What the apps talk to beyond the database and cache — the serverless side of the simulated account
// (./providers/mock-names.ts), so the cloud map can connect ECS services to queues, topics, tables and buckets.
function cloudRefs(env: EnvName, kind: MSvc["kind"]): { name: string; value: string }[] {
  const prod = env === "production";
  // Production's data stores beyond Postgres and Valkey (mock-names: search, the sessions cache, rate limits, analytics).
  if (kind === "api")
    return [
      { name: "SESSIONS_TABLE", value: prod ? DYNAMO.sessions.name : DYNAMO.sessionsStaging.name },
      { name: "UPLOADS_BUCKET", value: prod ? MOCK_S3.uploads.name : MOCK_S3.uploadsStaging.name },
      ...(prod
        ? [
            { name: "EVENT_BUS_NAME", value: EVENTS.shopBus.name }, { name: "SEARCH_URL", value: `https://${OPENSEARCH.endpoint}` },
            { name: "SESSIONS_CACHE_URL", value: `rediss://${SERVERLESS_CACHE.endpoint}:6379` }, { name: "RATE_LIMIT_REDIS_URL", value: `rediss://${MEMORYDB.endpoint}:6379` },
          ]
        : [{ name: "ORDERS_QUEUE_URL", value: SQS.ordersStaging.url }]),
    ];
  if (kind === "worker")
    return prod
      ? [{ name: "NOTIFICATIONS_TOPIC_ARN", value: SNS.notifications.arn }, { name: "ANALYTICS_DATABASE_URL", value: `postgres://${AURORA.cluster.readerEndpoint}:5432/analytics` }]
      : [{ name: "NOTIFICATIONS_TOPIC_ARN", value: SNS.notificationsStaging.arn }];
  if (kind === "billing" && prod) return [{ name: "ORDERS_QUEUE_URL", value: SQS.orders.url }];
  return [];
}
function initialEnv(E: Estate, env: EnvName, kind: MSvc["kind"], port: number): MEnv {
  const { secrets: SECRETS, files: FILES } = E;
  if (kind === "caddy" || kind === "redis") return { environment: [], secrets: [], files: [] };
  if (env === EU_ENV) {
    // eu-west-1: its own database, one key in SSM there.
    const param = `/acme/production-eu/${kind}/JWT_SIGNING_KEY`;
    SECRETS.set(param, `jwt-fake-${kind}-eu`);
    return {
      environment: [
        { name: "NODE_ENV", value: "production" }, { name: "PORT", value: String(port) }, { name: "LOG_LEVEL", value: "info" },
        { name: "DATABASE_URL", value: `postgres://app:pg-${kind}-eu-pass@${EU.rds.host}:5432/${kind}` }, { name: "PUBLIC_URL", value: `https://${kind}.eu.acme.dev` },
      ],
      secrets: [{ name: "JWT_SIGNING_KEY", valueFrom: `arn:aws:ssm:${EU_REGION}:${ACCT}:parameter${param}` }],
      files: [],
    };
  }
  const base = [{ name: "NODE_ENV", value: env }, { name: "PORT", value: String(port) }, { name: "LOG_LEVEL", value: env === "production" ? "info" : "debug" }];
  if (kind === "console") return { environment: [...base, { name: "CONSOLE_SOURCE", value: "aws" }], secrets: [], files: [] };
  const db = { name: "DATABASE_URL", value: `postgres://app:pg-${kind}-${env}-pass@${dbHost(`acme-${env}-pg`)}:5432/${kind}` };
  if (env === "production") {
    const sm = smArn(`acme/production/${kind}`);
    SECRETS.set(sm, JSON.stringify({ stripe_key: `sk_live_fake_${kind}`, webhook_secret: `whsec_fake_${kind}` }));
    SECRETS.set(`/acme/production/${kind}/JWT_SIGNING_KEY`, `jwt-fake-${kind}-prod`);
    return {
      environment: [...base, db, { name: "REDIS_URL", value: `rediss://${VALKEY_HOST}:6379/0` }, { name: "PUBLIC_URL", value: `https://${kind}.acme.dev` }, ...cloudRefs(env, kind)],
      secrets: [
        { name: "JWT_SIGNING_KEY", valueFrom: `arn:aws:ssm:${REGION}:${ACCT}:parameter/acme/production/${kind}/JWT_SIGNING_KEY` },
        { name: "STRIPE_SECRET_KEY", valueFrom: `${sm}:stripe_key::` },
      ],
      files: [],
    };
  }
  // Staging shares the host network, so peers are reached on localhost.
  const peer = kind === "api" ? [{ name: "JOBS_URL", value: "http://127.0.0.1:8080" }] : kind === "worker" ? [{ name: "API_URL", value: "http://127.0.0.1:3000" }] : [];
  const file = `arn:aws:s3:::acme-config/staging/${kind}.env`;
  FILES.set(file, `# ${kind} — staging settings (read by ECS at task start)\nSMTP_HOST=smtp.acme.dev\nSMTP_PASSWORD=smtp-fake-${kind}\nFEATURE_FLAGS=new-checkout,fast-search\n`);
  return { environment: [...base, db, { name: "REDIS_URL", value: "redis://127.0.0.1:6379/1" }, ...peer, ...cloudRefs(env, kind)], secrets: [], files: [file] };
}

// ---------- deterministic randomness ----------
function h32(a: number) {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function strHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const rnd = (s: string) => h32(strHash(s));
const hex40 = (s: string) => {
  let out = "";
  for (let i = 0; out.length < 40; i++) out += Math.floor(rnd(`${s}#${i}`) * 0xffffffff).toString(16).padStart(8, "0");
  return out.slice(0, 40);
};
const pick = <T,>(a: readonly T[], r: number) => a[Math.floor(r * a.length) % a.length];
// An image's digest (the same image string always has the same one), an S3 object's ETag (MD5 of its body, like S3's
// for a single-part upload) and a Secrets Manager version id.
const digestOf = (image: string) => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const etagOf = (text: string) => `"${createHash("md5").update(text).digest("hex")}"`;
const uuidOf = (s: string) => {
  const h = hex40(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const T0 = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const RATE_MULT = Number(process.env.MOCK_LOG_RATE_MULT || 1);

const TITLES = [
  "fix(checkout): guard empty cart on submit", "feat(cart): save items for later", "perf(search): cap page size at 100",
  "chore(deps): bump fastify to 5.6", "fix(email): retry 429 with jittered backoff", "feat(admin): show refund reason",
  "refactor(pricing): single discount resolver", "fix(webhooks): retry fulfillment 503s", "feat(billing): prorate plan changes",
  "fix(auth): refresh token rotation race", "feat(search): typo-tolerant queries", "chore: tighten request queue timeout",
  "fix(queue): commit offsets after durable write", "feat(admin): signed URLs for product images", "fix(health): /ready checks redis ping",
];
const AUTHORS = ["alice-acme", "bob-acme", "carol-acme", "dependabot[bot]"];

// ---------- git history shared by revisions and CI ----------
interface Push {
  sha: string;
  at: number;
  title: string;
  author: string;
  failed: boolean;
}
const pushCache = new Map<string, Push[]>();
function pushes(repo: string, branch: string): Push[] {
  const key = `${repo}@${branch}`;
  let p = pushCache.get(key);
  if (!p) {
    p = Array.from({ length: 30 }, (_, k) => {
      const seed = `${key}:${k}`;
      return {
        sha: hex40(seed),
        at: T0 - k * 2.7 * HOUR - Math.floor(rnd(seed + "j") * 40 * MIN) - 20 * MIN,
        title: pick(TITLES, rnd(seed + "t")),
        author: pick(AUTHORS, rnd(seed + "a")),
        failed: k > 0 && rnd(seed + "f") < 0.12,
      };
    });
    pushCache.set(key, p);
  }
  return p;
}

// What each push changed, derived from its sha: two or three source files, now and then a Prisma migration (repos that
// declare console:migrations), and in every branch history one bulk change (a regenerated client: 320 files with a
// migration last) so a compare across it comes back cut at GitHub's 300 files with complete: false (R25), and only
// listing the migrations directory at both ends finds that migration.
const SRC_FILES = [
  "src/app.ts", "src/modules/orders/orders.service.ts", "src/modules/cart/cart.service.ts", "src/modules/pricing/discounts.ts",
  "src/modules/search/search.controller.ts", "src/lib/http.ts", "test/orders.test.ts",
];
const MIGRATIONS = "prisma/migrations/";
const BASE_MIGRATIONS = ["20250114093000_init", "20250302120000_orders", "20250611081500_customers"];
const COMPARE_FILE_CAP = 300; // GitHub's compare returns at most 300 files
const BULK_AT = 9; // the bulk push's place in each branch history (0 = newest)
const hasMigrations = (repo: string) => DEMO.some((d) => d.repo === repo && d.migrations);
const migrationOf = (p: Push) =>
  `${new Date(p.at).toISOString().replace(/\D/g, "").slice(0, 14)}_${pick(["order_notes", "cart_expiry", "refund_reason", "search_index", "invoice_tax_region"], rnd(`${p.sha}n`))}`;
function filesOf(repo: string, branch: string, p: Push): string[] {
  const n = 2 + Math.floor(rnd(`${p.sha}c`) * 2);
  const files = Array.from({ length: n }, (_, i) => SRC_FILES[(strHash(`${p.sha}/${i}`) + i) % SRC_FILES.length]);
  const mig = `${MIGRATIONS}${migrationOf(p)}/migration.sql`;
  if (pushes(repo, branch).indexOf(p) === BULK_AT) {
    files.push(...Array.from({ length: 320 }, (_, i) => `src/generated/client/model-${String(i).padStart(3, "0")}.ts`));
    if (hasMigrations(repo)) files.push(mig);
  } else if (hasMigrations(repo) && rnd(`${p.sha}m`) < 0.15) files.push(mig);
  return [...new Set(files)];
}
// A branch name or a sha → the push it names (a branch: its newest), and the branch it is on.
function resolveRef(repo: string, ref: string): { branch: string; push: Push } | undefined {
  if (BRANCHES.includes(ref)) return { branch: ref, push: pushes(repo, ref)[0] };
  for (const branch of BRANCHES) {
    const push = pushes(repo, branch).find((p) => p.sha === ref);
    if (push) return { branch, push };
  }
  return undefined;
}

// ---------- simulated services ----------
interface MRev {
  arn: string;
  revision: number;
  image: string;
  sha?: string;
  registeredAt: number;
  imagePresent: boolean;
  env: MEnv;
}
interface MTask {
  id: string;
  start: number;
  end?: number;
}
interface MSvc {
  env: EnvName;
  cluster: string;
  name: string;
  launch: "EC2" | "FARGATE";
  desired: number;
  revs: MRev[]; // ascending by revision
  live: number; // index into revs
  deployments: RawDeployment[];
  pendingSwitch?: { to: number; dep: string; fail: boolean };
  tgArn?: string;
  healthcheck?: string;
  cpu: string;
  memory: string;
  memoryReservation?: number;
  port: number;
  rate: number; // log lines per second
  stopAt?: number;
  startAt?: number;
  tasks: MTask[];
  kind: "api" | "worker" | "billing" | "caddy" | "redis" | "console";
  // create & scale: services the console created, scaling and one-off tasks
  family?: string; // when it isn't "<name>-<env>" (copies: the service's own name)
  tags?: Record<string, string>; // copies: the tags CreateService was given
  net?: { subnets: string[]; sgs: string[] };
  createDep?: string; // the creation deployment: completing it starts the first task instead of replacing one
  bornAt?: number;
  scaleFrom?: number;
  scaleAt?: number;
  deletedAt?: number; // DeleteService: drains for a few seconds, then leaves the cluster
  oneOff?: { id: string; at: number; container: string; command: boolean }[];
}

// The staging host (us-east-1 only).
interface MBox { state: string; since: number; to?: string; at: number }
// EC2 hosts launched through the console (the demo's own host is the estate's `box`): pending → running after 15 s,
// registered with the ECS cluster (in hosts()) 90 s after launch — until then only taggedHosts() sees them (R23);
// terminated ones shut down for 10 s, then leave the cluster.
interface MHost {
  id: string; env: EnvName; name: string; type: string; state: string; since: number; to?: string; at: number; tags: Record<string, string>;
  launchedAt?: number; // unset on hosts an older module version launched: treated as registered
}
const REGISTER_MS = 90_000;
const registered = (h: MHost, now: number) => h.launchedAt === undefined || now - h.launchedAt >= REGISTER_MS;
const BOX_TAGS = { Name: "acme-staging" };
interface MDb { state: string; to?: string; at: number; cls: string; gb: number; multiAz: boolean; vpc: string; sg: string; aurora?: string }

// One region of the simulated account and everything that changes in it.
interface Estate {
  region: string;
  clusters: Record<string, ClusterSpec>;
  svcs: Map<string, MSvc>; // "<env>/<service>"
  rds: Record<string, MDb>;
  caches: RawCache[];
  sgs: Record<string, RawSecurityGroup>;
  vpcOf: (subnet: string) => string;
  box?: MBox;
  extraHosts: Map<string, MHost>;
  alb?: string; // the ALB in front of production (us-east-1 only)
  secrets: Map<string, string>; // valueFrom (or secret id) → value
  files: Map<string, string>; // s3 object ARN → env file text
  // Task definitions registered as copies, until CreateService picks them up; families the console created (→ revision).
  copies: Map<string, { rev: MRev; from: MSvc; cpu: string; memory: string }>;
  copyFamilies: Map<string, number>;
  // Optional: an estate an older module version created (kept on globalThis) has neither; both are created on use.
  versions?: Map<string, number>; // secret key → version number (R05)
  tokens?: Map<string, { requestId: string; taskArn?: string; instanceIds?: string[] }>; // client token → first answer (F31)
}

const KIND: Record<string, MSvc["kind"]> = {
  api: "api", worker: "worker", billing: "billing", caddy: "caddy", redis: "redis", "deployment-console": "console",
};
const SPEC: Record<MSvc["kind"], { cpu: string; mem: string; res?: number; port: number; rate: number; hc?: string; img: string }> = {
  api: { cpu: "1024", mem: "1024", res: 256, port: 3000, rate: 25, hc: "CMD wget -qO- http://127.0.0.1:3000/health", img: "storefront-api" },
  worker: { cpu: "512", mem: "256", res: 64, port: 8080, rate: 70, hc: "CMD bash -c exec 3<>/dev/tcp/127.0.0.1/8080", img: "jobs" },
  billing: { cpu: "256", mem: "384", res: 128, port: 3010, rate: 6, hc: "CMD wget -qO- http://127.0.0.1:3010/health", img: "billing" },
  caddy: { cpu: "128", mem: "64", res: 32, port: 443, rate: 9, img: "caddy" },
  redis: { cpu: "128", mem: "320", res: 32, port: 6379, rate: 0.4, hc: "CMD redis-cli ping", img: "redis" },
  console: { cpu: "256", mem: "512", port: 3000, rate: 2, img: "deployment-console" },
};

const clusterIn = (E: Estate, env: EnvName) => Object.keys(E.clusters).find((c) => E.clusters[c].env === env)!;
const envOfCluster = (E: Estate, cluster: string) => (Object.hasOwn(E.clusters, cluster) ? E.clusters[cluster].env : undefined);

function makeSvc(E: Estate, env: EnvName, name: string, o: { desired?: number; net?: MSvc["net"] } = {}): MSvc {
  const kind = KIND[name];
  const sp = SPEC[kind];
  const cfg = DEMO.find((s) => s.ecs === name)!;
  const acct = ecrOf(E.region);
  const cluster = clusterIn(E, env);
  const cl = E.clusters[cluster];
  const family = taskFamily(env, name);
  const menv = initialEnv(E, env, kind, sp.port);
  const desired = o.desired ?? 1;
  let revs: MRev[];
  if (cfg.repo) {
    const ps = pushes(cfg.repo, cl.branch).filter((p) => !p.failed).slice(0, 24).reverse();
    revs = ps.map((p, i) => ({
      arn: `arn:aws:ecs:${E.region}:${ACCT}:task-definition/${family}:${100 + i}`,
      revision: 100 + i,
      image: `${acct}/${ECR_REPO_OF[name] ?? sp.img}:${cl.tagPrefix}${p.sha}`,
      sha: p.sha,
      registeredAt: p.at + 6 * MIN,
      imagePresent: !(name === "api" && i === 2), // one expired image, to show a disabled rollback
      env: menv,
    }));
  } else {
    const tag = kind === "caddy" ? "2-alpine" : "7-alpine";
    revs = [1, 2, 3].map((i) => ({
      arn: `arn:aws:ecs:${E.region}:${ACCT}:task-definition/${family}:${i}`,
      revision: i, image: `${sp.img}:${tag}`, registeredAt: T0 - (4 - i) * 86_400_000, imagePresent: true, env: menv,
    }));
  }
  const live = revs.length - 1;
  const created = revs[live].registeredAt + 30_000;
  const taskId = hex40(`${env}/${name}/task0`).slice(0, 32);
  const svc: MSvc = {
    env, cluster, name, kind, launch: env === "staging" ? "EC2" : "FARGATE", desired, revs, live,
    deployments: [{
      id: `ecs-svc/${Math.floor(rnd(env + name) * 1e18)}`, status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: revs[live].arn,
      desired, running: desired, pending: 0, failedTasks: 0, createdAt: created, updatedAt: created + 90_000,
    }],
    tgArn: env === "production" && E.alb ? `arn:aws:elasticloadbalancing:${E.region}:${ACCT}:targetgroup/${name.slice(0, 20)}-prod/${hex40(name).slice(0, 16)}` : undefined,
    healthcheck: sp.hc, cpu: sp.cpu, memory: sp.mem, memoryReservation: env === "staging" ? sp.res : undefined, port: sp.port,
    rate: sp.rate * (env === "staging" && kind === "worker" ? 2.5 : 1) * RATE_MULT,
    tasks: [
      { id: hex40(`${env}/${name}/task-1`).slice(0, 32), start: created - 2 * 86_400_000, end: created },
      { id: taskId, start: created },
    ],
    ...(o.net ? { net: o.net } : {}),
  };
  // Prod demo: a rollout that failed 12 minutes ago and was rolled back by the circuit breaker.
  if (env === "production" && name === "billing") {
    svc.deployments.push({
      id: "ecs-svc/failed-rollout", status: "INACTIVE", rolloutState: "FAILED", rolloutReason: "ECS deployment circuit breaker: tasks failed to start.",
      taskDefinition: `${revs[live].arn.replace(/:\d+$/, "")}:${revs[live].revision + 1}`, desired: 0, running: 0, pending: 0, failedTasks: 3,
      createdAt: T0 - 17 * MIN, updatedAt: T0 - 12 * MIN,
    });
  }
  return svc;
}

const emptyEstate = (region: string, vpcOf: Estate["vpcOf"]): Estate => ({
  region, clusters: {}, svcs: new Map(), rds: {}, caches: [], sgs: {}, vpcOf, extraHosts: new Map(), secrets: new Map(), files: new Map(), copies: new Map(), copyFamilies: new Map(),
});
const sgIn = (E: Estate, vpcId: string, id: string, name: string, inbound: RawSecurityGroup["inbound"] = []) => (E.sgs[id] = { id, name, vpcId, inbound });

// us-east-1: the Acme shop — staging on one ECS-on-EC2 host, production on Fargate behind an ALB.
function homeEstate(): Estate {
  const E = emptyEstate(REGION, (id) => (id.includes("prod") ? "vpc-prod" : "vpc-stg"));
  Object.assign(E.clusters, CLUSTERS);
  const sg = (id: string, name: string, inbound: RawSecurityGroup["inbound"] = []) => sgIn(E, id.includes("stg") ? "vpc-stg" : "vpc-prod", id, name, inbound);
  sg("sg-stg-box", "staging-host");
  // The exposed staging database (mock-names NETWORK.exposedDb): 5432 also open to the internet.
  sg("sg-stg-db", "staging-db", [{ fromPort: 5432, toPort: 5432, groups: ["sg-stg-box"] }, { fromPort: 5432, toPort: 5432, groups: [], cidrs: [NETWORK.exposedDb.openTo] }]);
  sg("sg-prod-alb", "prod-alb");
  sg("sg-prod-api", "storefront-api", [{ fromPort: 3000, toPort: 3000, groups: ["sg-prod-alb", "sg-prod-worker"] }]);
  sg("sg-prod-worker", "jobs", [{ fromPort: 8080, toPort: 8080, groups: ["sg-prod-alb", "sg-prod-api"] }]);
  sg("sg-prod-billing", "billing", [{ fromPort: 3010, toPort: 3010, groups: ["sg-prod-alb"] }]);
  sg("sg-prod-console", "console", [{ fromPort: 3000, toPort: 3000, groups: ["sg-prod-alb"] }]);
  // Postgres for the apps; the search domain (443) for api and the analytics warehouse (5439) for worker share the group.
  sg("sg-prod-db", "prod-db", [
    { fromPort: 5432, toPort: 5432, groups: ["sg-prod-api", "sg-prod-worker", "sg-prod-billing"] },
    { fromPort: 443, toPort: 443, groups: ["sg-prod-api"] }, { fromPort: 5439, toPort: 5439, groups: ["sg-prod-worker"] },
  ]);
  sg("sg-prod-valkey", "prod-valkey", [{ fromPort: 6379, toPort: 6379, groups: ["sg-prod-api", "sg-prod-worker", "sg-prod-billing"] }]);
  E.alb = ALB_ARN;
  E.box = { state: "running", since: T0 - 3 * 86_400_000, to: undefined, at: 0 };
  E.rds = {
    "acme-staging-pg": { state: "available", at: 0, cls: "db.t4g.small", gb: 20, multiAz: false, vpc: "vpc-stg", sg: "sg-stg-db" },
    "acme-production-pg": { state: "available", at: 0, cls: "db.r6g.large", gb: 100, multiAz: false, vpc: "vpc-prod", sg: "sg-prod-db" },
    // Aurora members (storage lives on the cluster, providers/mock/rds-cluster.ts): DescribeDBInstances lists them too.
    ...Object.fromEntries(AURORA.cluster.members.map((id) => [id, { state: "available", at: 0, cls: "db.r6g.large", gb: 0, multiAz: false, vpc: "vpc-prod", sg: "sg-prod-db", aurora: AURORA.cluster.id }])),
  };
  E.caches = [{
    id: "acme-production-valkey", status: "available", engine: "valkey", engineVersion: "8.0", nodeType: "cache.t4g.small", nodes: 1, endpoint: VALKEY_HOST, port: 6379,
    securityGroups: ["sg-prod-valkey"], arn: `arn:aws:elasticache:${REGION}:${ACCT}:replicationgroup:acme-production-valkey`, kmsKeyId: KMS_KEYS.app.arn,
    memberClusters: ["acme-production-valkey-001"], subnetGroup: "acme-production-cache", createdAt: T0 - 300 * 86_400_000, transitEncryption: true,
    atRestEncryption: true, authToken: false, snapshotRetentionDays: 3, snapshotWindow: "06:00-07:00", maintenanceWindow: "sun:07:00-sun:08:00",
    parameterGroup: "default.valkey8", automaticFailover: "disabled", multiAz: false,
    // What the elasticache provider adds with its own calls (subnet group, tags), so the demo shows them too.
    vpcId: NETWORK.production.vpc, subnetIds: [...NETWORK.production.privateSubnets], tags: { "console:env": "production" },
  }];
  for (const env of ["staging", "production"] as EnvName[]) {
    // Application Auto Scaling keeps production api between 2 and 6 tasks (AUTOSCALING below).
    for (const s of DEMO.filter((x) => x.envs.includes(env))) E.svcs.set(`${env}/${s.ecs}`, makeSvc(E, env, s.ecs, env === "production" && s.ecs === "api" ? { desired: 2 } : {}));
  }
  return E;
}

// eu-west-1 (mock-names EU): cluster "acme-production" on Fargate with api ×2 and worker ×1 in their own VPC, one
// private Postgres reachable only from them, no cache and no load balancer.
function euEstate(): Estate {
  const E = emptyEstate(EU_REGION, (id) => (id.startsWith("subnet-eu-") ? EU.vpc.id : "vpc-unknown"));
  E.clusters[EU.cluster] = { env: EU_ENV, branch: PROD_BRANCH, tagPrefix: "production-", ec2: false };
  const g = EU.securityGroups;
  sgIn(E, EU.vpc.id, g.api, "storefront-api-eu", [{ fromPort: 3000, toPort: 3000, groups: [g.worker] }]);
  sgIn(E, EU.vpc.id, g.worker, "jobs-eu", [{ fromPort: 8080, toPort: 8080, groups: [g.api] }]);
  sgIn(E, EU.vpc.id, g.db, "prod-eu-db", [{ fromPort: 5432, toPort: 5432, groups: [g.api, g.worker] }]);
  E.rds[EU.rds.id] = { state: "available", at: 0, cls: "db.r6g.large", gb: 100, multiAz: false, vpc: EU.vpc.id, sg: EU.rds.securityGroup };
  for (const id of EU.auroraSecondary.members) E.rds[id] = { state: "available", at: 0, cls: "db.r6g.large", gb: 0, multiAz: false, vpc: EU.vpc.id, sg: EU.securityGroups.db, aurora: EU.auroraSecondary.id };
  for (const s of EU.services) {
    const sgId = s.name === "api" ? g.api : g.worker;
    E.svcs.set(`${EU_ENV}/${s.name}`, makeSvc(E, EU_ENV, s.name, { desired: s.tasks, net: { subnets: [...EU.vpc.subnets], sgs: [sgId] } }));
  }
  return E;
}

const ge = globalThis as { __consoleMockEstates?: Map<string, Estate> };
function estate(region: string): Estate {
  const all = (ge.__consoleMockEstates ??= new Map());
  let E = all.get(region);
  if (!E) all.set(region, (E = region === REGION ? homeEstate() : region === EU_REGION ? euEstate() : emptyEstate(region, () => "vpc-unknown")));
  return E;
}

const svcOf = (E: Estate, env: EnvName, name: string) => {
  const s = E.svcs.get(`${env}/${name}`);
  if (!s) throw Object.assign(new Error(`ServiceNotFoundException: ${name}`), { name: "ServiceNotFoundException" });
  return s;
};
const famOf = (s: MSvc) => s.family ?? taskFamily(s.env, s.name);
const DRAIN_MS = 8_000;

const ROLL_MS = 24_000;
const boxUp = (E: Estate, now: number) => {
  tickBox(E, now);
  return !E.box || E.box.state === "running";
};

function tickBox(E: Estate, now: number) {
  const box = E.box;
  if (box?.to && now >= box.at) {
    box.state = box.to;
    box.since = box.at;
    box.to = undefined;
    if (box.state === "running") for (const s of E.svcs.values()) if (s.env === "staging" && s.desired > 0) s.startAt = now;
  }
  for (const d of Object.values(E.rds)) if (d.to && now >= d.at) {
    d.state = d.to;
    d.to = undefined;
  }
  for (const [id, h] of E.extraHosts) if (h.to && now >= h.at) {
    if (h.to === "terminated") E.extraHosts.delete(id);
    else Object.assign(h, { state: h.to, since: h.at, to: undefined });
  }
}

function tick(s: MSvc, now: number) {
  for (const d of s.deployments) {
    if (d.rolloutState !== "IN_PROGRESS" || now - d.createdAt < ROLL_MS) continue;
    const sw = s.pendingSwitch?.dep === d.id ? s.pendingSwitch : undefined;
    if (sw?.fail) {
      d.rolloutState = "FAILED";
      d.rolloutReason = "ECS deployment circuit breaker: tasks failed to start.";
      d.status = "INACTIVE";
      d.updatedAt = d.createdAt + ROLL_MS;
      s.deployments.find((x) => x.status === "ACTIVE")!.status = "PRIMARY";
    } else {
      d.rolloutState = "COMPLETED";
      d.updatedAt = d.createdAt + ROLL_MS;
      d.running = 1;
      if (sw) s.live = sw.to;
      s.deployments = s.deployments.filter((x) => x === d || x.rolloutState === "FAILED");
      if (d.id !== s.createDep) {
        const last = s.tasks[s.tasks.length - 1];
        last.end = d.createdAt + 6_000;
        s.tasks.push({ id: hex40(`${s.name}/${d.id}`).slice(0, 32), start: d.createdAt + 10_000 });
      }
    }
    s.pendingSwitch = undefined;
  }
  s.deployments = s.deployments.filter((d) => d.rolloutState !== "FAILED" || now - d.updatedAt < 2 * HOUR);
}

// awsvpc tasks get an address in their VPC (mock-names NETWORK / EU), stable per task; host-network tasks have none.
const VPC_PREFIX: Record<string, string> = { production: "10.20", [EU_ENV]: "10.40" };
const taskIp = (s: MSvc, taskId: string) =>
  s.launch === "FARGATE" && Object.hasOwn(VPC_PREFIX, s.env) ? `${VPC_PREFIX[s.env]}.${10 + (strHash(taskId) % 2)}.${20 + (strHash(`${taskId}/ip`) % 200)}` : undefined;
const homeProd = (s: MSvc) => s.env === "production"; // "production" only exists in us-east-1 (eu-west-1's env is production-eu)

// What the task definition says beyond the container: roles (mock-names IAM_ROLES; production has a task role per
// service), the EFS volume production worker mounts, and the service's Cloud Map registry (api and worker register in
// acme.internal; billing's registry has no instances because its service runs without it).
function taskDefExtras(s: MSvc): Pick<RawTaskDef, "taskRoleArn" | "executionRoleArn" | "volumes"> {
  const roleKey = s.kind === "console" ? "console" : s.kind;
  const task = homeProd(s) && Object.hasOwn(IAM_ROLES.tasks, roleKey) ? IAM_ROLES.tasks[roleKey as keyof typeof IAM_ROLES.tasks].arn : undefined;
  const efs = homeProd(s) && s.name === EFS.media.mountedBy.service && s.cluster === EFS.media.mountedBy.cluster;
  return {
    executionRoleArn: IAM_ROLES.taskExecution.arn,
    ...(task ? { taskRoleArn: task } : {}),
    ...(efs ? { volumes: [{ name: "media", efs: { fileSystemId: EFS.media.id, accessPointId: EFS.media.accessPoint.id } }] } : {}),
  };
}
const registryOf = (s: MSvc) => (homeProd(s) && (s.name === "api" || s.name === "worker") ? CLOUDMAP.services[s.name].arn : undefined);

// A service's events, newest first, as DescribeServices keeps them (no slice: F11).
function eventsOf(s: MSvc, now: number): RawEvent[] {
  const ev: RawEvent[] = [];
  for (const d of s.deployments) {
    ev.push({ id: `${d.id}-start`, at: d.createdAt, message: `(service ${s.name}) has started 1 tasks: (task ${s.tasks[s.tasks.length - 1].id.slice(0, 12)}).` });
    if (d.rolloutState === "COMPLETED") ev.push({ id: `${d.id}-done`, at: d.updatedAt, message: `(service ${s.name}) (deployment ${d.id}) deployment completed.` });
    if (d.rolloutState === "FAILED") ev.push({ id: `${d.id}-fail`, at: d.updatedAt, message: `(service ${s.name}) (deployment ${d.id}) deployment failed: tasks failed to start. Rolling back.` });
  }
  for (const t of s.oneOff ?? []) {
    ev.push({ id: `${t.id}-run`, at: t.at, message: `(task ${t.id.slice(0, 12)}) one-off task started by deployment-console${t.command ? ` with a command override for ${t.container}` : ""}.` });
    if (now - t.at > 20_000) ev.push({ id: `${t.id}-stop`, at: t.at + 20_000, message: `(task ${t.id.slice(0, 12)}) one-off task stopped: essential container exited with code 0.` });
  }
  for (let k = 0; k < 12; k++) {
    const at = Math.floor((now - k * 6 * HOUR) / (6 * HOUR)) * 6 * HOUR;
    ev.push({ id: `steady-${at}`, at, message: `(service ${s.name}) has reached a steady state.` });
  }
  return ev.sort((a, b) => b.at - a.at);
}

function rawService(E: Estate, s: MSvc, now: number): RawService {
  tick(s, now);
  const onBox = s.env !== "staging" || boxUp(E, now);
  const inProg = s.deployments.find((d) => d.rolloutState === "IN_PROGRESS");
  const td = s.revs[s.live];
  const task = s.tasks[s.tasks.length - 1];
  let running = 0;
  let health: RawTask["health"] = "HEALTHY";
  let lastStatus = "RUNNING";
  if (!onBox) running = 0;
  else if (s.desired === 0) running = s.stopAt && now - s.stopAt < 4_000 ? 1 : 0;
  else if (inProg) {
    const e = now - inProg.createdAt;
    const fresh = inProg.id === s.createDep; // a new service has no old task serving during its first rollout
    running = e < 6_000 ? (fresh ? 0 : s.desired) : e < 10_000 ? 0 : s.desired;
    health = e < 18_000 ? "UNKNOWN" : "HEALTHY";
    lastStatus = (e >= 6_000 || fresh) && e < 10_000 ? "PENDING" : "RUNNING";
  } else if (s.startAt && now - s.startAt < 15_000) {
    running = now - s.startAt < 6_000 ? 0 : s.desired;
    health = "UNKNOWN";
    lastStatus = now - s.startAt < 6_000 ? "PENDING" : "RUNNING";
  } else if (s.scaleAt && s.scaleFrom !== undefined && s.scaleFrom < s.desired && now - s.scaleAt < 10_000) running = s.scaleFrom; // new tasks still starting
  else running = s.desired;
  const hasHc = !!s.healthcheck;
  if (!hasHc) health = "UNKNOWN";
  const tasks: RawTask[] = [];
  // A running task's ENI address and the digest its container runs (F18, F68).
  const live = (id: string, status: string) => ({
    ...(status === "RUNNING" && taskIp(s, id) ? { privateIp: taskIp(s, id) } : {}), imageDigests: { [s.name]: digestOf(td.image) },
  });
  if (onBox && (running > 0 || lastStatus === "PENDING")) {
    tasks.push({
      id: task.id, taskDefinition: td.arn, lastStatus, desiredStatus: "RUNNING", health, hasHealthcheck: hasHc,
      startedAt: task.start, cpu: s.cpu, memory: s.memory, ...live(task.id, lastStatus),
    });
    // Scaled services: the other running tasks (same health; the newest started when the count went up).
    for (let i = 1; i < running; i++) {
      const id = hex40(`${task.id}/${i}`).slice(0, 32);
      tasks.push({
        id, taskDefinition: td.arn, lastStatus: "RUNNING", desiredStatus: "RUNNING", health, hasHealthcheck: hasHc,
        startedAt: s.scaleAt && i >= (s.scaleFrom ?? 1) ? s.scaleAt + 8_000 : task.start, cpu: s.cpu, memory: s.memory, ...live(id, "RUNNING"),
      });
    }
  }
  const prev = s.tasks[s.tasks.length - 2];
  if (prev?.end) tasks.push({
    id: prev.id, taskDefinition: td.arn, lastStatus: "STOPPED", desiredStatus: "STOPPED", health: "UNKNOWN", hasHealthcheck: hasHc,
    startedAt: prev.start, stoppedAt: prev.end, stoppedReason: "Scaling activity initiated by (deployment ecs-svc)", exitCode: 0, imageDigests: { [s.name]: digestOf(td.image) },
  });
  const registry = registryOf(s);
  return {
    name: s.name, cluster: s.cluster, status: s.deletedAt ? "DRAINING" : "ACTIVE", desired: s.desired, running,
    pending: !onBox || s.desired === 0 ? 0 : Math.max(lastStatus === "PENDING" ? 1 : 0, s.desired - running),
    launchType: s.launch,
    deployments: s.deployments.map((d) => ({ ...d, running: d.status === "PRIMARY" ? running : d.running, desired: d.status === "PRIMARY" ? s.desired : d.desired })),
    tasks,
    taskDef: {
      arn: td.arn, family: famOf(s), revision: td.revision, image: td.image, cpu: s.cpu, memory: s.memory,
      memoryReservation: s.memoryReservation, networkMode: s.launch === "EC2" ? "host" : "awsvpc", launchTypes: [s.launch],
      arch: s.kind === "console" ? "arm64" : undefined, // the console itself runs on Graviton in the demo
      healthcheck: s.healthcheck, ports: [s.port], logGroup: logGroup(s.env, s.name), registeredAt: td.registeredAt,
      main: s.name,
      containers: [{ name: s.name, image: td.image, essential: true, ports: [s.port], logGroup: logGroup(s.env, s.name), logStreamPrefix: "ecs", envHosts: hostsFromEnv(td.env.environment) }],
      ...taskDefExtras(s),
    },
    targetGroupArns: s.tgArn ? [s.tgArn] : [],
    circuitBreaker: true,
    createdAt: s.bornAt ?? T0 - 20 * 86_400_000,
    tags: tagsOf(s),
    securityGroups: s.net?.sgs ?? (s.env === "production" ? [PROD_SG[s.name]] : []),
    subnets: s.net?.subnets ?? (s.env === "production" ? ["subnet-prod-a", "subnet-prod-b"] : []),
    events: eventsOf(s, now),
    deploymentController: "ECS",
    ...(registry ? { serviceRegistries: [{ registryArn: registry }] } : {}),
    ...(s.launch === "FARGATE" ? { assignPublicIp: false } : {}),
    tasksComplete: true,
    stoppedComplete: true,
  };
}

// The production ALB's targets: one per running task, at the task's address. Draining while a stopped service's last
// task winds down, registering (initial) until a task with a health check reports healthy; the ALB checks the others
// itself, so a container without a health check can still be a healthy target.
function tgTargets(E: Estate, s: MSvc, now: number): RawLbTarget[] {
  const r = rawService(E, s, now);
  const WHY: Record<string, [string, string]> = {
    draining: ["Target.DeregistrationInProgress", "Target deregistration is in progress"],
    unhealthy: ["Target.FailedHealthChecks", "Health checks failed with these codes: [503]"],
    initial: ["Elb.RegistrationInProgress", "Target registration is in progress"],
  };
  return r.tasks.filter((t) => t.lastStatus === "RUNNING").map((t, i) => {
    const state = s.desired === 0 ? "draining" : t.health === "UNHEALTHY" ? "unhealthy" : t.health === "HEALTHY" || !t.hasHealthcheck ? "healthy" : "initial";
    const why = Object.hasOwn(WHY, state) ? WHY[state] : undefined;
    return { id: t.privateIp ?? t.id, port: s.port, az: `${E.region}${i % 2 ? "b" : "a"}`, state, ...(why ? { reason: why[0], description: why[1] } : {}) };
  });
}

// The production ALB's configuration (F58: no health in it).
function albConfig(E: Estate): LbConfig {
  const prod = [...E.svcs.values()].filter((s) => s.env === "production" && s.tgArn);
  const hostOf: Record<string, string> = { api: "api.acme.dev", worker: "jobs.acme.dev", billing: "billing.acme.dev", "deployment-console": "console.acme.dev" };
  return {
    arn: E.alb ?? "",
    name: "acme-production", dns: `acme-production-1839406127.${REGION}.elb.amazonaws.com`, scheme: "internet-facing", type: "application", state: "active",
    azs: [`${REGION}a`, `${REGION}b`], createdAt: T0 - 9 * 86_400_000,
    listeners: [
      {
        port: 443, protocol: "HTTPS",
        rules: [
          ...prod.map((s, i) => ({ priority: String((i + 1) * 10), hosts: [hostOf[s.name]], paths: [], action: s.name === "deployment-console" ? "authenticate-oidc+forward" : "forward", targetGroupArn: s.tgArn })),
          { priority: "default", hosts: [], paths: [], action: "fixed-response" },
        ],
      },
      { port: 80, protocol: "HTTP", rules: [{ priority: "default", hosts: [], paths: [], action: "redirect" }] },
    ],
    targetGroups: prod.map((s) => ({
      arn: s.tgArn!, name: s.tgArn!.split("/")[1], port: s.port, protocol: "HTTP", healthPath: s.name === "deployment-console" ? "/api/healthz" : "/ready",
      healthInterval: 15, healthyThreshold: 2, unhealthyThreshold: 3, matcher: "200",
    })),
  };
}

// The internal ops ALB (mock-names STANDALONE_ALB): no ECS service behind it, one instance target failing its check.
function standaloneConfig(): LbConfig {
  const a = STANDALONE_ALB;
  return {
    arn: a.arn, name: a.name, dns: a.dns, scheme: "internal", type: "application", state: "active", azs: [`${REGION}a`, `${REGION}b`], createdAt: T0 - 210 * 86_400_000,
    listeners: [{ port: 80, protocol: "HTTP", rules: [{ priority: "default", hosts: [], paths: [], action: "forward", targetGroupArn: a.tg.arn }] }],
    targetGroups: [{ arn: a.tg.arn, name: a.tg.name, port: a.tg.port, protocol: "HTTP", healthPath: "/status", healthInterval: 30, healthyThreshold: 3, unhealthyThreshold: 2, matcher: "200" }],
  };
}
const standaloneTarget = () => ({ id: STANDALONE_ALB.tg.target, port: STANDALONE_ALB.tg.port, az: `${REGION}a`, state: "unhealthy", reason: "Target.FailedHealthChecks", description: "Health checks failed with these codes: [502]" });

// RDS posture (F16), as DescribeDBInstances reports it. acme-staging-pg is the exposed one (mock-names NETWORK).
function dbPosture(region: string, id: string, aurora?: string): Partial<RawDb> {
  const day = 86_400_000;
  const ca = { caCertificate: "rds-ca-rsa2048-g1", caValidTill: T0 + 400 * day, maintenanceWindow: "sun:04:00-sun:04:30", optionGroup: "default:postgres-17" };
  // Aurora members: encryption, backups and deletion protection are the cluster's (providers/mock/rds-cluster.ts).
  if (aurora) {
    const eu = region === EU_REGION;
    return {
      caCertificate: ca.caCertificate, caValidTill: ca.caValidTill, maintenanceWindow: eu ? "sun:06:00-sun:06:30" : "sun:05:00-sun:05:30", kmsKeyId: eu ? KMS_KEYS.appReplica.arn : KMS_KEYS.app.arn,
      publiclyAccessible: false, subnetIds: eu ? [...EU.vpc.subnets] : [...NETWORK.production.privateSubnets], subnetGroup: eu ? "acme-production-eu-db" : "acme-production-db",
      createdAt: T0 - (eu ? 120 : 400) * day, storageEncrypted: true, backupRetentionDays: 7, deletionProtection: false, parameterGroup: "default.aurora-postgresql16",
    };
  }
  if (region === EU_REGION) {
    return { ...ca, kmsKeyId: KMS_KEYS.appReplica.arn, publiclyAccessible: false, subnetIds: [...EU.vpc.subnets], subnetGroup: "acme-production-eu-db", createdAt: T0 - 120 * day, storageEncrypted: true, backupRetentionDays: 7, deletionProtection: true, backupWindow: "02:00-02:30", parameterGroup: "acme-postgres17" };
  }
  if (id === NETWORK.exposedDb.id) {
    return { ...ca, publiclyAccessible: true, subnetIds: [...NETWORK.staging.namedPrivateSubnets], subnetGroup: "acme-staging-db", createdAt: T0 - 200 * day, storageEncrypted: false, backupRetentionDays: 1, deletionProtection: false, backupWindow: "05:00-05:30", parameterGroup: "default.postgres17" };
  }
  return { ...ca, kmsKeyId: KMS_KEYS.app.arn, publiclyAccessible: false, subnetIds: [...NETWORK.production.privateSubnets], subnetGroup: "acme-production-db", createdAt: T0 - 400 * day, storageEncrypted: true, backupRetentionDays: 7, deletionProtection: true, backupWindow: "03:00-03:30", parameterGroup: "acme-postgres17" };
}

// Application Auto Scaling (CC-20): production api scales between 2 and 6 tasks on CPU — the target-tracking policy
// behind mock-names ALARMS (its AlarmHigh/AlarmLow pair). Other services and eu-west-1 have no scalable targets.
const AUTOSCALING: Record<string, { targets: SdkScalableTarget[]; policies: SdkScalingPolicy[] }> = {
  [REGION]: {
    targets: [{ ResourceId: "service/acme-production/api", ScalableDimension: ECS_DIMENSION, MinCapacity: 2, MaxCapacity: 6 }],
    policies: [{
      PolicyName: "acme-api-cpu-target", PolicyType: "TargetTrackingScaling", ResourceId: "service/acme-production/api", ScalableDimension: ECS_DIMENSION,
      TargetTrackingScalingPolicyConfiguration: { TargetValue: 60, PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" } },
    }],
  },
};

// The key and version label of a secret reference: SSM parameters count 1, 2, 3…; Secrets Manager versions are ids.
const secretKey = (ref: SecretRef) => (ref.kind === "ssm" ? ref.name : ref.secretId);
const versionLabel = (ref: SecretRef, n: number) => (ref.kind === "ssm" ? String(n) : uuidOf(`${ref.secretId}#${n}`));
const versionOf = (E: Estate, ref: SecretRef) => (E.versions ??= new Map()).get(secretKey(ref)) ?? 1;

// Tags a team adds once so discovery can name things and link repos (all optional).
function tagsOf(s: MSvc): Record<string, string> {
  if (s.tags) return s.tags;
  const d = DEMO.find((x) => x.ecs === s.name)!;
  const t: Record<string, string> = {};
  if (d.name) t["console:name"] = d.name;
  if (d.repo) t["console:repo"] = d.repo;
  if (d.healthcheck?.[s.env]) t["console:healthcheck"] = d.healthcheck[s.env]!;
  if (s.name === "deployment-console") t["console:self"] = "true";
  if (d.migrations) t["console:migrations"] = "prisma/migrations/";
  return t;
}

function probeIn(E: Estate, cluster: string, name: string, url: string): ProbeResult {
  const r = rawService(E, svcOf(E, envOfCluster(E, cluster) ?? cluster, name), Date.now());
  const up = r.running > 0 && r.tasks.some((t) => t.lastStatus === "RUNNING");
  const ms = 30 + Math.floor(rnd(`${name}${Math.floor(Date.now() / 10_000)}`) * 60);
  return up ? { url, pass: true, consecutiveFailures: 0, status: 200, ms } : { url, pass: false, consecutiveFailures: 2, status: 502, ms };
}
// Health probes of the us-east-1 estate.
export const mockProbe = (cluster: string, name: string, url: string): ProbeResult => probeIn(estate(REGION), cluster, name, url);

// ---------- logs ----------
// Time is cut into slots sized so each holds ~2 lines on average; busy services get 1ms slots with several lines each.
const HOSTS = ["ip-10-0-1-23", "ip-10-0-2-41"];
const URLS = [
  "/api/v1/products?category=shoes&page=3", "/api/v1/products/sku/AC-88213", "/api/v1/cart", "/api/v1/orders", "/api/v1/checkout/session",
  "/api/v1/search?q=running%20shoes", "/api/v1/customers/me", "/api/v1/recommendations", "/health", "/api/v1/products/filters",
];
const QUEUES = ["order-events", "inventory-sync", "email-outbox", "search-index", "webhooks"];

function message(kind: MSvc["kind"], ts: number, r: number, r2: number): string {
  const iso = new Date(ts).toISOString();
  const lvl = r2 < 0.012 ? "error" : r2 < 0.06 ? "warn" : r2 < 0.1 ? "debug" : "info";
  const req = `req-${Math.floor(r * 1e6).toString(36)}`;
  switch (kind) {
    // Node service logging pino JSON.
    case "api": {
      if (lvl === "error") return JSON.stringify({ level: 50, time: ts, pid: 1, hostname: HOSTS[0], reqId: req, err: { type: "PrismaClientKnownRequestError", message: "Unique constraint failed on the fields: (`cart_id`,`product_id`)", stack: "PrismaClientKnownRequestError: Unique constraint failed\n    at Kn.handleRequestError (/app/node_modules/@prisma/client/runtime/library.js:121:7753)\n    at CartService.addItem (/app/dist/modules/cart/cart.service.js:88:21)" }, msg: "cart add failed" });
      if (lvl === "warn") return JSON.stringify({ level: 40, time: ts, pid: 1, hostname: HOSTS[0], reqId: req, durationMs: 800 + Math.floor(r * 2400), msg: "slow query", model: "products", op: "findMany" });
      if (r < 0.03) return JSON.stringify({ level: 30, time: ts, pid: 1, hostname: HOSTS[0], msg: "cron: abandoned-cart-reminders finished", processed: Math.floor(r * 400) });
      const url = pick(URLS, r * 7.13);
      const status = r2 > 0.985 ? 404 : url.includes("orders") && r > 0.8 ? 201 : 200;
      return JSON.stringify({ level: lvl === "debug" ? 20 : 30, time: ts, pid: 1, hostname: HOSTS[0], reqId: req, req: { method: url.includes("cart") && r > 0.5 ? "POST" : "GET", url }, res: { statusCode: status }, responseTime: Math.round((5 + r * 180) * 10) / 10, msg: "request completed" });
    }
    // Go worker logging logfmt (slog text handler).
    case "worker": {
      if (lvl === "error") return `time=${iso} level=ERROR msg="webhook delivery failed" target=fulfillment order=${Math.floor(r * 9e6)} err="503 Service Unavailable"`;
      if (lvl === "warn") return `time=${iso} level=WARN msg="email provider rate limited, backing off" retry_in=${1 + Math.floor(r * 8)}s attempt=${1 + Math.floor(r2 * 5)}`;
      if (r < 0.05) return `time=${iso} level=INFO msg="admin request" method=GET path=/admin/jobs/health status=200 took=${Math.floor(r * 90)}ms`;
      return `time=${iso} level=${lvl.toUpperCase()} msg="queue batch committed" queue=${pick(QUEUES, r * 3.3)} partition=${Math.floor(r * 12)} offset=${1_800_000 + Math.floor(ts / 97) % 900_000} records=${50 + Math.floor(r * 450)} took=${8 + Math.floor(r2 * 80)}ms`;
    }
    case "billing":
      if (lvl === "error") return JSON.stringify({ level: 50, time: ts, msg: "invoice rejected", reason: "tax region missing", invoice: `INV-${Math.floor(r * 50000)}` });
      return JSON.stringify({ level: lvl === "warn" ? 40 : 30, time: ts, msg: r < 0.4 ? "invoice batch processed" : "request completed", batch: "nightly", invoices: Math.floor(r * 2000), responseTime: Math.round(r * 90) });
    case "caddy": {
      const host = r < 0.62 ? "api.staging.acme.dev" : r < 0.9 ? "jobs.staging.acme.dev" : "billing.staging.acme.dev";
      // Long-tailed latency: exponential around ~35ms, slower for the API host.
      const dur = (0.004 + -Math.log(1 - Math.min(r2, 0.999)) * (host.startsWith("api") ? 0.04 : 0.018)) * (r2 > 0.995 ? 6 : 1);
      const status = lvl === "error" ? 502 : r2 > 0.97 ? 404 : r > 0.95 ? 201 : 200;
      return JSON.stringify({ level: lvl === "error" ? "error" : "info", ts: ts / 1000, logger: "http.log.access.log0", msg: "handled request", request: { host, method: r > 0.8 ? "POST" : "GET", uri: pick(URLS, r * 3.1) }, status, duration: Math.round(dur * 100000) / 100000 });
    }
    case "redis":
      return `1:M ${new Date(ts).toUTCString().slice(5, 25)}.${String(ts % 1000).padStart(3, "0")} ${r < 0.5 ? "* 100 changes in 300 seconds. Saving..." : "* Background saving terminated with success"}`;
    case "console":
      return JSON.stringify({ level: 30, time: ts, msg: "request completed", req: { method: "GET", url: pick(["/api/overview?env=staging", "/api/logs/tail", "/api/ci/runs"], r) }, res: { statusCode: 200 }, responseTime: Math.round(r * 40) });
  }
}

const slotMs = (s: MSvc) => Math.min(2000, Math.max(1, Math.round(1000 / (s.rate * 0.5))));

function slotLines(s: MSvc, slot: number, out: { ts: number; msg: string }[]) {
  const size = slotMs(s);
  const seed = strHash(`${s.env}/${s.name}`);
  const expect = s.rate * (size / 1000);
  const n = Math.floor(expect) + (h32(seed ^ slot) < expect % 1 ? 1 : 0);
  for (let j = 0; j < n; j++) {
    const r1 = h32(seed + slot * 7 + j * 131);
    const r2 = h32(seed ^ (slot * 31 + 11 + j * 17));
    const ts = slot * size + Math.floor(((j + r1) / n) * size);
    out.push({ ts, msg: message(s.kind, ts, r1, r2) });
  }
}

// Log groups are /ecs/acme-<env>/<service> (logGroup above).
const svcFromGroup = (E: Estate, group: string) => {
  const m = /^\/ecs\/acme-([^/]+)\/(.+)$/.exec(group);
  if (!m || !Object.values(E.clusters).some((c) => c.env === m[1])) throw Object.assign(new Error("ResourceNotFoundException"), { name: "ResourceNotFoundException" });
  return svcOf(E, m[1], m[2]);
};
const streamName = (s: MSvc, t: MTask) => `ecs/${s.name}/${t.id}`;
const taskOf = (s: MSvc, stream: string) => s.tasks.find((t) => streamName(s, t) === stream);
const liveEnd = (E: Estate, s: MSvc, t: MTask, now: number) => {
  const running = rawService(E, s, now).running > 0;
  return t.end ?? (running ? now : Math.min(now, s.stopAt ?? now));
};

// CloudWatch filter pattern subset: "exact phrase", term (AND), ?term (OR group), -term, { $.field op value }.
function cwPattern(p?: string): ((m: string) => boolean) | undefined {
  if (!p?.trim()) return undefined;
  const t = p.trim();
  const json = /^\{\s*\$\.([\w.]+)\s*(=|!=|>=|<=|>|<)\s*("?)([^"}]*)\3\s*\}$/.exec(t);
  if (json) {
    const [, key, op, , raw] = json;
    const leaf = key.split(".").pop()!;
    return (m) => {
      const v = new RegExp(`"${leaf}"\\s*:\\s*"?([^",}]*)`).exec(m)?.[1];
      if (v === undefined) return false;
      const a = Number(v), b = Number(raw);
      if (op === "=" || op === "!=") return (Number.isFinite(a) && Number.isFinite(b) ? a === b : v === raw) === (op === "=");
      return Number.isFinite(a) && (op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b);
    };
  }
  const terms = [...t.matchAll(/(-|\?)?"([^"]+)"|(-|\?)?(\S+)/g)].map((m) => ({ mod: m[1] ?? m[3] ?? "", v: m[2] ?? m[4] }));
  const any = terms.filter((x) => x.mod === "?"), all = terms.filter((x) => x.mod === ""), none = terms.filter((x) => x.mod === "-");
  return (m) => all.every((x) => m.includes(x.v)) && none.every((x) => !m.includes(x.v)) && (!any.length || any.some((x) => m.includes(x.v)));
}

// Scan slots in one direction collecting up to `limit` lines inside [lo, hi].
function scan(s: MSvc, lo: number, hi: number, dir: 1 | -1, limit: number, match?: string, pred?: (m: string) => boolean) {
  const out: { ts: number; msg: string }[] = [];
  const size = slotMs(s);
  const a = Math.floor(lo / size);
  const b = Math.floor(hi / size);
  const MAX = 3_000_000;
  const buf: { ts: number; msg: string }[] = [];
  let steps = 0;
  outer: for (let slot = dir === 1 ? a : b; dir === 1 ? slot <= b : slot >= a; slot += dir) {
    if (++steps > MAX) break;
    buf.length = 0;
    slotLines(s, slot, buf);
    if (dir === -1) buf.reverse();
    for (const l of buf) {
      if (l.ts < lo || l.ts > hi) continue;
      if (match && !l.msg.includes(match)) continue;
      if (pred && !pred(l.msg)) continue;
      out.push(l);
      if (out.length >= limit) break outer;
    }
  }
  if (dir === -1) out.reverse();
  return { out, exhausted: steps <= MAX };
}

// ---------- CI simulation ----------
interface Step {
  name: string;
  secs: number;
}
const API_UNIT: Step[] = [
  { name: "Set up job", secs: 2 }, { name: "Run actions/checkout@v4", secs: 3 }, { name: "Run pnpm/action-setup@v4", secs: 2 },
  { name: "Run actions/setup-node@v4", secs: 6 }, { name: "Run pnpm install --frozen-lockfile", secs: 38 }, { name: "Run pnpm prisma:generate", secs: 9 },
  { name: "Run pnpm build", secs: 41 }, { name: "Run pnpm lint", secs: 22 }, { name: "Run cp .env.test.example .env.test", secs: 1 },
  { name: "Run pnpm test:unit", secs: 64 }, { name: "Run pnpm test:contract", secs: 33 }, { name: "Complete job", secs: 1 },
];
const API_INT: Step[] = [
  { name: "Set up job", secs: 2 }, { name: "Initialize containers", secs: 21 }, { name: "Run actions/checkout@v4", secs: 3 },
  { name: "Run pnpm install --frozen-lockfile", secs: 36 }, { name: "Run pnpm prisma:deploy", secs: 14 },
  { name: "Run psql seed-smoke.sql", secs: 3 }, { name: "Run pnpm test:integration", secs: 118 }, { name: "Complete job", secs: 1 },
];
const GO_CI: Step[] = [
  { name: "Set up job", secs: 2 }, { name: "Run actions/checkout@v4", secs: 3 }, { name: "Run actions/setup-go@v5", secs: 11 },
  { name: "Run go vet ./...", secs: 19 }, { name: "Run go build ./cmd/worker", secs: 24 }, { name: "Run go test -race ./...", secs: 96 },
  { name: "Run make stress", secs: 58 }, { name: "Complete job", secs: 1 },
];
const CONSOLE_CI: Step[] = [
  { name: "Set up job", secs: 2 }, { name: "Run actions/checkout@v4", secs: 3 }, { name: "Run actions/setup-node@v4", secs: 5 },
  { name: "Run npm ci", secs: 28 }, { name: "Run npm run typecheck", secs: 14 }, { name: "Run npm run lint", secs: 12 },
  { name: "Run npm test", secs: 6 }, { name: "Run npm run build", secs: 52 }, { name: "Complete job", secs: 1 },
];
const DEPLOY: Step[] = [
  { name: "Set up job", secs: 2 }, { name: "Run actions/checkout@v4", secs: 3 }, { name: "Resolve target environment", secs: 1 },
  { name: "Configure AWS credentials (OIDC)", secs: 3 }, { name: "Run aws-actions/amazon-ecr-login@v2", secs: 2 },
  { name: "Build and push image", secs: 142 }, { name: "Render + register task definition", secs: 4 }, { name: "ecs update-service", secs: 3 },
  { name: "Wait for services-stable", secs: 95 }, { name: "Complete job", secs: 1 },
];
const WORKFLOWS: Record<string, { name: string; jobs: { name: string; steps: Step[]; tests?: string }[] }[]> = {
  "acme/storefront-api": [
    { name: "Tests", jobs: [{ name: "build + lint + unit + contract", steps: API_UNIT, tests: "unit" }, { name: "integration", steps: API_INT, tests: "integration" }] },
    { name: "deploy", jobs: [{ name: "deploy", steps: DEPLOY }] },
  ],
  "acme/jobs": [
    { name: "ci", jobs: [{ name: "test", steps: GO_CI, tests: "go" }] },
    { name: "deploy", jobs: [{ name: "deploy", steps: DEPLOY }] },
  ],
  "acme/billing": [{ name: "deploy", jobs: [{ name: "deploy", steps: DEPLOY }] }],
  "acme/deployment-console": [
    { name: "ci", jobs: [{ name: "verify", steps: CONSOLE_CI, tests: "console" }] },
    { name: "deploy", jobs: [{ name: "deploy", steps: DEPLOY }] },
  ],
};

interface MRun {
  run: CiRun;
  jobs: { name: string; steps: Step[]; tests?: string }[];
  startedAt: number;
  failAt?: { job: number; step: number };
}
const reruns = new Map<number, { attempt: number; at: number; failedOnly: boolean }>();

function buildRuns(repo: string, now: number): MRun[] {
  const out: MRun[] = [];
  const wfs = WORKFLOWS[repo] ?? [];
  const tested = wfs.some((w) => w.name !== "deploy");
  for (const branch of BRANCHES) {
    const list = pushes(repo, branch);
    // A live push on staging that restarts every 9 minutes (repos with a test workflow), so there is always
    // something in progress to watch.
    const liveAt = Math.floor(now / (9 * MIN)) * 9 * MIN;
    const live: Push | null = branch === STAGING_BRANCH && tested
      ? { sha: hex40(`${repo}:live:${liveAt}`), at: liveAt, title: pick(TITLES, rnd(`${liveAt}${repo}`)), author: AUTHORS[0], failed: false }
      : null;
    for (const p of [...(live ? [live] : []), ...list.slice(0, 12)]) {
      let offset = 0;
      for (const [wi, wf] of wfs.entries()) {
        const id = 17_000_000_000 + (strHash(`${repo}:${branch}:${p.sha}:${wf.name}`) % 900_000_000);
        const failJob = p.failed && wf.name !== "deploy" ? 0 : -1;
        const isDeploy = wf.name === "deploy";
        if (isDeploy && p.failed) continue;
        const start = p.at + offset * 1000 + wi * 2000;
        if (!isDeploy) offset = Math.max(...wf.jobs.map((j) => j.steps.reduce((a, s) => a + s.secs, 0))) + 8;
        out.push({
          run: {
            id, repo, workflow: wf.name, workflowPath: `.github/workflows/${wf.name.toLowerCase()}.yml`, workflowId: strHash(`${repo}:${wf.name}`) % 1_000_000,
            branch, sha: p.sha, title: p.title, actor: p.author, event: "push", status: "completed",
            conclusion: failJob >= 0 ? "failure" : "success", attempt: 1, createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(), url: `https://github.com/${repo}/actions/runs/${id}`,
          },
          jobs: wf.jobs,
          startedAt: start,
          failAt: failJob >= 0 ? { job: 0, step: wf.jobs[0].steps.findIndex((s) => s.name.includes("test")) } : undefined,
        });
      }
    }
  }
  // Apply reruns and live progress.
  for (const m of out) {
    const rr = reruns.get(m.run.id);
    if (rr) {
      m.startedAt = rr.at;
      m.run.attempt = rr.attempt;
      m.failAt = undefined;
    }
    const total = Math.max(...m.jobs.map((j) => j.steps.reduce((a, s) => a + s.secs, 0))) * 1000;
    const done = now - m.startedAt >= total;
    m.run.status = now < m.startedAt ? "queued" : done ? "completed" : "in_progress";
    m.run.conclusion = done ? (m.failAt ? "failure" : "success") : null;
    m.run.createdAt = new Date(m.startedAt).toISOString();
    m.run.updatedAt = new Date(Math.min(now, m.startedAt + total)).toISOString();
  }
  return out.filter((m) => m.startedAt <= now + 60_000).sort((a, b) => b.startedAt - a.startedAt);
}

function jobsOf(m: MRun, now: number): CiJob[] {
  return m.jobs.map((j, ji) => {
    let t = m.startedAt;
    let failed = false;
    const steps = j.steps.map((s, si) => {
      const st = t;
      t += s.secs * 1000;
      const isFail = !failed && m.failAt?.job === ji && m.failAt.step === si;
      let status = now >= t ? "completed" : now >= st ? "in_progress" : "queued";
      let conclusion: string | null = status === "completed" ? (isFail ? "failure" : "success") : null;
      if (failed) {
        status = "completed";
        conclusion = "skipped";
      }
      if (isFail && status === "completed") failed = true;
      return { number: si + 1, name: s.name, status, conclusion, startedAt: now >= st ? new Date(st).toISOString() : undefined, completedAt: status === "completed" && conclusion !== "skipped" ? new Date(t).toISOString() : undefined };
    });
    const allDone = steps.every((s) => s.status === "completed");
    return {
      id: m.run.id * 10 + ji, name: j.name, status: allDone ? "completed" : steps.some((s) => s.status !== "queued") ? "in_progress" : "queued",
      conclusion: allDone ? (steps.some((s) => s.conclusion === "failure") ? "failure" : "success") : null,
      startedAt: new Date(m.startedAt).toISOString(), completedAt: allDone ? new Date(t).toISOString() : undefined, steps, url: `${m.run.url}/job/${m.run.id * 10 + ji}`,
    };
  });
}

function findRun(repo: string, id: number) {
  const m = buildRuns(repo, Date.now()).find((x) => x.run.id === id);
  if (!m) throw Object.assign(new Error("run not found"), { status: 404 });
  return m;
}

function junitXml(kind: string, failed: boolean) {
  const suites: Record<string, string[]> = {
    unit: ["orders", "cart", "pricing", "checkout", "auth", "search"],
    integration: ["catalog", "checkout", "promotions", "notifications"],
    go: ["queue", "webhooks", "email", "admin"],
    console: ["status", "actions", "auth", "logstore", "junit"],
  };
  const cases: string[] = [];
  for (const s of suites[kind] ?? ["suite"]) {
    const n = 8 + (strHash(s) % 30);
    for (let i = 0; i < n; i++) {
      const name = `${s} case ${i + 1}`;
      const fail = failed && s === suites[kind][0] && i === 3;
      cases.push(
        fail
          ? `<testcase classname="${s}" name="${s} rejects an expired discount code" time="0.041"><failure message="Expected values to be strictly equal:&#10;&#10;409 !== 200">AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n409 !== 200\n    at TestContext.&lt;anonymous&gt; (tests/${kind}/${s}.test.ts:88:12)</failure></testcase>`
          : `<testcase classname="${s}" name="${name}" time="${(0.005 + (strHash(name) % 90) / 1000).toFixed(3)}"/>`,
      );
    }
  }
  return `<testsuites><testsuite name="${kind}">${cases.join("")}</testsuite></testsuites>`;
}

// ---------- Insights emulation: filter @message like /re/ | "text", and stats count(*) by bin(Nm) ----------
const insights = new Map<string, { readyAt: number; result: InsightsResult }>();
// Performance queries over Caddy access logs: stats count/avg/pct(duration) by bin(X)[, request.host], optional status >= 500.
function runStatsInsights(E: Estate, groups: string[], query: string, start: number, end: number): InsightsResult {
  const bin = /by\s+bin\((\d+)([smh])\)/i.exec(query)!;
  const size = Number(bin[1]) * (bin[2] === "h" ? HOUR : bin[2] === "m" ? MIN : 1000);
  const byHost = /request\.host/.test(query.split(/\bby\b/i)[1] ?? "");
  const only5xx = /status\s*>=\s*500/.test(query);
  const groupsMap = new Map<string, number[]>();
  let scanned = 0;
  for (const g of groups) {
    const s = svcFromGroup(E, g);
    const { out } = scan(s, start, end, 1, 2_000_000);
    scanned += out.length;
    for (const e of out) {
      if (!e.msg.includes("http.log.access")) continue;
      const status = Number(/"status":(\d+)/.exec(e.msg)?.[1] ?? 0);
      if (only5xx && status < 500) continue;
      const host = /"host":"([^"]+)"/.exec(e.msg)?.[1] ?? "";
      const k = `${Math.floor(e.ts / size) * size}|${byHost ? host : ""}`;
      const dur = Number(/"duration":([\d.]+)/.exec(e.msg)?.[1] ?? 0);
      (groupsMap.get(k) ?? groupsMap.set(k, []).get(k)!).push(dur);
    }
  }
  const iso = (t: number) => new Date(t).toISOString().replace("T", " ").replace("Z", "");
  const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  const rows = [...groupsMap.entries()].map(([k, durs]) => {
    const [t, host] = k.split("|");
    durs.sort((a, b) => a - b);
    const row: Record<string, string> = { [`bin(${bin[1]}${bin[2]})`]: iso(Number(t)) };
    if (byHost) row["request.host"] = host;
    if (only5xx) row.e = String(durs.length);
    else Object.assign(row, { n: String(durs.length), avg: String(durs.reduce((a, b) => a + b, 0) / durs.length), p50: String(pct(durs, 50)), p90: String(pct(durs, 90)), p99: String(pct(durs, 99)) });
    return row;
  });
  return { status: "Complete", rows, stats: { recordsMatched: rows.length, recordsScanned: scanned, bytesScanned: scanned * 260 } };
}

function runInsights(E: Estate, groups: string[], query: string, start: number, end: number, limit: number): InsightsResult {
  if (/pct\(duration/.test(query) || (/status\s*>=\s*500/.test(query) && /by\s+bin/.test(query))) return runStatsInsights(E, groups, query, start, end);
  const re = /\/((?:[^/\\]|\\.)+)\/([a-z]*)/.exec(query);
  const lit = /like\s+"([^"]+)"/.exec(query) ?? /"([^"]+)"/.exec(query);
  const test = re ? ((m: string) => new RegExp(re[1], re[2]).test(m)) : lit ? ((m: string) => m.includes(lit[1])) : () => true;
  const levelErr = /level\s*>=?\s*50|level\s*=\s*"?error/i.test(query);
  const rows: { ts: number; msg: string; stream: string }[] = [];
  let scanned = 0;
  for (const g of groups) {
    const s = svcFromGroup(E, g);
    const { out } = scan(s, Math.max(start, end - 6 * HOUR), end, -1, 20_000);
    scanned += out.length;
    for (const e of out) if (test(e.msg) && (!levelErr || /"level":5\d|level=ERROR/.test(e.msg))) rows.push({ ...e, stream: `${s.name}/${s.tasks[s.tasks.length - 1].id}` });
  }
  rows.sort((a, b) => b.ts - a.ts);
  const bin = /stats\s+count\(\*\)(?:\s+as\s+\w+)?\s+by\s+bin\((\d+)([smh])\)/i.exec(query);
  const iso = (t: number) => new Date(t).toISOString().replace("T", " ").replace("Z", "");
  let out: Record<string, string>[];
  if (bin) {
    const size = Number(bin[1]) * (bin[2] === "h" ? HOUR : bin[2] === "m" ? MIN : 1000);
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(Math.floor(r.ts / size) * size, (counts.get(Math.floor(r.ts / size) * size) ?? 0) + 1);
    out = [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([t, c]) => ({ [`bin(${bin[1]}${bin[2]})`]: iso(t), "count(*)": String(c) }));
  } else {
    out = rows.slice(0, limit).map((r) => ({ "@timestamp": iso(r.ts), "@message": r.msg, "@logStream": r.stream }));
  }
  return { status: "Complete", rows: out, stats: { recordsMatched: rows.length, recordsScanned: scanned, bytesScanned: scanned * 220 } };
}

// ---------- exports ----------
// The simulated account in one region (default: us-east-1, the Acme shop).
export function mockCloud(region: string = REGION): Cloud {
  const E = estate(region);
  const ALB = E.alb ?? "";
  return {
    kind: "mock",
    region: E.region,
    async clusters() {
      return Object.entries(E.clusters).map(([name, c]) => {
        const mine = [...E.svcs.values()].filter((s) => s.env === c.env);
        return {
          name, arn: `arn:aws:ecs:${E.region}:${ACCT}:cluster/${name}`, status: "ACTIVE", tags: { "console:branch": c.branch },
          activeServices: mine.length, runningTasks: mine.length, capacityProviders: c.ec2 ? [] : ["FARGATE", "FARGATE_SPOT"],
          containerInstances: c.ec2 ? 1 + [...E.extraHosts.values()].filter((h) => h.env === c.env && registered(h, Date.now())).length : 0,
        };
      });
    },
    async services(cluster) {
      const env = envOfCluster(E, cluster);
      if (!env) throw Object.assign(new Error(`ClusterNotFoundException: ${cluster}`), { name: "ClusterNotFoundException" });
      const now = Date.now();
      for (const [k, s] of E.svcs) if (s.deletedAt && now - s.deletedAt > DRAIN_MS) E.svcs.delete(k);
      return [...E.svcs.values()].filter((s) => s.env === env).map((s) => rawService(E, s, now));
    },
    async hosts(cluster) {
      if (!Object.hasOwn(E.clusters, cluster) || !E.clusters[cluster].ec2) return [];
      const now = Date.now();
      tickBox(E, now);
      const box = E.box;
      const b: RawBox[] = box ? [{
        id: BOX_ID, name: "acme-staging", state: box.state, type: "t3a.small", launchedAt: box.state === "running" ? box.since : undefined,
        privateIp: "10.10.1.21", publicIp: box.state === "running" ? "203.0.113.10" : undefined, az: `${E.region}a`, platform: "Linux/UNIX",
        vpcId: "vpc-stg", securityGroups: ["sg-stg-box"], tags: BOX_TAGS, agentConnected: box.state === "running",
      }] : [];
      // Container instances only: a launched host shows here once it has joined the cluster (taggedHosts sees it sooner).
      const more = [...E.extraHosts.values()].filter((h) => h.env === E.clusters[cluster].env && registered(h, now)).map((h): RawBox => ({
        id: h.id, name: h.name, state: h.state, type: h.type, launchedAt: h.state === "running" ? h.since : undefined, privateIp: `10.10.1.${30 + (strHash(h.id) % 200)}`,
        az: `${E.region}a`, platform: "Linux/UNIX", vpcId: "vpc-stg", securityGroups: ["sg-stg-box"], tags: h.tags, agentConnected: h.state === "running",
      }));
      return [...b, ...more];
    },
    async instances(ids) {
      const all = (await Promise.all(Object.keys(E.clusters).map((c) => this.hosts(c)))).flat();
      return all.filter((h) => ids.includes(h.id));
    },
    // R23: instances the console launched for this cluster, pending or running, whether they joined it yet or not.
    async taggedHosts(cluster) {
      tickBox(E, Date.now());
      return [...E.extraHosts.values()]
        .filter((h) => h.tags["console:created"] === "true" && h.tags["console:cluster"] === cluster && (h.state === "pending" || h.state === "running"))
        .map((h) => ({ id: h.id, state: h.state, launchedAt: h.launchedAt ?? h.since }));
    },
    async databases() {
      tickBox(E, Date.now());
      return Object.entries(E.rds).map(([id, d]): RawDb => ({
        id, status: d.state, engine: d.aurora ? AURORA.cluster.engine : "postgres", engineVersion: d.aurora ? "16.4" : "17.6", instanceClass: d.cls, storageGb: d.gb, multiAz: d.multiAz,
        endpoint: dbHost(id, E.region), port: 5432, vpcId: d.vpc, securityGroups: [d.sg], tags: {}, ...dbPosture(E.region, id, d.aurora),
        ...(d.aurora ? { aurora: d.aurora } : {}),
      }));
    },
    async caches(): Promise<RawCache[]> {
      return E.caches.map((c) => ({ ...c, securityGroups: [...c.securityGroups] }));
    },
    async securityGroups(ids) {
      return ids.flatMap((id) => (Object.hasOwn(E.sgs, id) ? [E.sgs[id]] : []));
    },
    async subnetVpcs(ids) {
      return Object.fromEntries(ids.map((id) => [id, E.vpcOf(id)]));
    },
    async lbConfig(arn) {
      if (E.region === REGION && arn === STANDALONE_ALB.arn) return standaloneConfig();
      if (!E.alb || arn !== E.alb) throw Object.assign(new Error(`LoadBalancerNotFound: ${arn}`), { name: "LoadBalancerNotFoundException" });
      return albConfig(E);
    },
    async targetGroupLbs(arns) {
      return Object.fromEntries(arns.map((a) => [a, a === STANDALONE_ALB.tg.arn ? STANDALONE_ALB.arn : ALB]));
    },
    async logAround(group, stream, ts, n) {
      const s = svcFromGroup(E, group);
      const t = taskOf(s, stream);
      const lo = t?.start ?? ts - HOUR;
      const hi = t ? liveEnd(E, s, t, Date.now()) : Date.now();
      return { before: scan(s, lo, ts - 1, -1, n).out, after: scan(s, ts, hi, 1, n + 1).out };
    },
    async insightsStart(groups, query, start, end, limit) {
      const id = `mock-q-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
      insights.set(id, { readyAt: Date.now() + 900, result: runInsights(E, groups, query, start, Math.min(end, Date.now()), limit) });
      return id;
    },
    async insightsResults(id) {
      const q = insights.get(id);
      if (!q) return { status: "Unknown", rows: [] };
      if (Date.now() < q.readyAt) return { status: "Running", rows: [] };
      return q.result;
    },
    async targetHealth(arns) {
      const now = Date.now();
      return arns.map((arn) => {
        if (E.region === REGION && arn === STANDALONE_ALB.tg.arn) return healthOf(arn, [standaloneTarget()]);
        const s = [...E.svcs.values()].find((x) => x.tgArn === arn);
        if (!s) throw Object.assign(new Error(`TargetGroupNotFound: ${arn}`), { name: "TargetGroupNotFoundException" });
        return healthOf(arn, tgTargets(E, s, now));
      });
    },
    async metrics(specs: MetricSpec[], minutes) {
      const now = Date.now();
      const step = periodFor(minutes) * 1000; // the period CloudWatch would use (F03): 1 min, 5 min or 1 h
      const out: Record<string, [number, number][]> = {};
      for (const sp of specs) {
        const key = `${sp.metric}:${Object.values(sp.dims).join("/")}`;
        const BASES: Record<string, number> = {
          FreeStorageSpace: 12e9, DatabaseConnections: 18, CPUCreditBalance: 180, RequestCountPerTarget: 400 + rnd(key) * 900, RequestCount: 1800,
          HTTPCode_Target_5XX_Count: 0.6, HTTPCode_ELB_5XX_Count: 0.15, TargetResponseTime: 0.045 + rnd(key) * 0.05, ReadLatency: 0.0012, WriteLatency: 0.0021, ReadIOPS: 45,
          WriteIOPS: 30, FreeableMemory: 9.5e9, NetworkIn: 38e6, NetworkOut: 52e6, ActiveConnectionCount: 1400, HealthyHostCount: 1, UnHealthyHostCount: 0,
          HTTPCode_ELB_503_Count: 0.02, // nearly none: the load balancer can route every request
        };
        // Every Sum (requests, error counts, evictions, network bytes) scales with the period, as CloudWatch's does (F03);
        // percentiles differ by statistic.
        const perBin = sp.stat === "Sum" || sp.metric === "RequestCount" || sp.metric.endsWith("_Count") || sp.metric === "ActiveConnectionCount" ? step / MIN : 1;
        const statMul = sp.stat === "p50" ? 0.62 : sp.stat === "p90" ? 1.9 : sp.stat === "p99" ? 4.2 : 1;
        // ALB request metrics share one traffic curve; each target group takes a fixed share, so the parts sum to the total.
        const albReq = sp.metric === "RequestCount" || sp.metric === "RequestCountPerTarget";
        const share = (tg: string) => 0.12 + rnd(tg) * 0.26;
        const prodTgs = [...E.svcs.values()].filter((x) => x.env === "production" && x.tgArn).map((x) => x.tgArn!.split(":").pop()!);
        const albBase = 1800 * (sp.dims.TargetGroup ? share(sp.dims.TargetGroup) : prodTgs.reduce((a, tg) => a + share(tg), 0));
        const base = albReq ? albBase * (step / MIN) : (BASES[sp.metric] ?? (sp.metric.startsWith("Memory") ? 35 + rnd(key) * 30 : 6 + rnd(key) * 22)) * perBin * statMul;
        const curve = albReq ? "alb-requests" : key;
        const pts: [number, number][] = [];
        for (let t = Math.floor((now - minutes * MIN) / step) * step; t <= now; t += step) {
          const wave = Math.sin(t / (17 * MIN) + rnd(curve) * 6) * 0.25 + Math.sin(t / (3 * MIN)) * 0.08;
          const noise = (h32(strHash(curve) ^ Math.floor(t / step)) - 0.5) * 0.2;
          pts.push([t, Math.max(0, base * (1 + wave + noise))]);
        }
        out[sp.id] = pts;
      }
      return out;
    },
    async revisions(family) {
      const s = [...E.svcs.values()].find((x) => famOf(x) === family);
      if (!s) return [];
      return [...s.revs].reverse().map<RawRevision>((r) => ({
        arn: r.arn, revision: r.revision, image: r.image, registeredAt: r.registeredAt, status: "ACTIVE", containers: [{ name: s.name, image: r.image, essential: true }],
      }));
    },
    async imageTags(repository) {
      const tags = new Set<string>();
      for (const s of E.svcs.values()) for (const r of s.revs) if (r.imagePresent && r.image.includes(`/${repository}:`)) tags.add(r.image.split(":").pop()!);
      return tags;
    },
    // R24/F68: whether an image is in this account's ECR (the region its registry names), by digest or tag.
    async imageExists(repository, ref) {
      const where = ecrTarget(repository, E.region);
      if (!where) return null;
      if (where.registryId && where.registryId !== ACCT) return { exists: false };
      const at = estate(where.region);
      const digest = ref.digest ?? where.digest;
      const tag = ref.tag ?? where.tag ?? "latest";
      for (const svc of at.svcs.values()) {
        for (const r of svc.revs) {
          const img = r.imagePresent && parseImageRef(r.image).ecr ? ecrTarget(r.image, at.region) : null; // Docker Hub images aren't in ECR
          if (!img || img.repositoryName !== where.repositoryName || img.region !== where.region) continue;
          if (digest ? digestOf(r.image) === digest : img.tag === tag) return { exists: true, digest: digestOf(r.image) };
        }
      }
      return { exists: false };
    },
    async events(cluster, service) {
      const s = svcOf(E, envOfCluster(E, cluster) ?? cluster, service);
      const now = Date.now();
      rawService(E, s, now);
      return eventsOf(s, now);
    },
    async scalableTargets(cluster) {
      const a = Object.hasOwn(AUTOSCALING, E.region) ? AUTOSCALING[E.region] : undefined;
      return a && Object.hasOwn(E.clusters, cluster) ? scalableTargetsOf(cluster, a.targets, a.policies) : [];
    },
    async updateService(cluster, service, change) {
      const s = svcOf(E, envOfCluster(E, cluster) ?? cluster, service);
      const now = Date.now();
      rawService(E, s, now);
      if (change.desired === 0) {
        s.desired = 0;
        s.stopAt = now;
        s.tasks[s.tasks.length - 1].end = now + 4_000;
      } else if (change.desired !== undefined && change.desired > 0 && s.desired > 0) {
        // Scaling a running service: no restart, the extra tasks start (or the surplus stops) alongside.
        s.scaleFrom = s.desired;
        s.scaleAt = now;
        s.desired = change.desired;
      } else if (change.desired !== undefined && change.desired > 0) {
        s.desired = change.desired;
        s.startAt = now;
        s.tasks.push({ id: hex40(`${service}/start/${now}`).slice(0, 32), start: now + 6_000 });
      }
      if (change.force || change.taskDefinition) {
        const to = change.taskDefinition ? s.revs.findIndex((r) => r.arn === change.taskDefinition) : s.live;
        if (to < 0) throw Object.assign(new Error("ClientException: TaskDefinition not found"), { name: "ClientException" });
        const prim = s.deployments.find((d) => d.status === "PRIMARY");
        if (prim) prim.status = "ACTIVE";
        const id = `ecs-svc/${Math.floor(rnd(`${service}${now}`) * 1e18)}`;
        s.deployments.unshift({ id, status: "PRIMARY", rolloutState: "IN_PROGRESS", taskDefinition: s.revs[to].arn, desired: 1, running: 0, pending: 1, failedTasks: 0, createdAt: now, updatedAt: now });
        // A revision whose image is gone would fail to pull — simulate the circuit breaker rolling it back.
        s.pendingSwitch = { to, dep: id, fail: !s.revs[to].imagePresent };
      }
      return `mock-${now.toString(36)}`;
    },
    async hostPower(id, action) {
      const now = Date.now();
      tickBox(E, now);
      const target = id === BOX_ID && E.box ? E.box : E.extraHosts.get(id);
      if (!target) throw Object.assign(new Error("InvalidInstanceID.NotFound"), { name: "InvalidInstanceID.NotFound" });
      Object.assign(target, action === "stop" ? { state: "stopping", to: "stopped", at: now + 12_000 } : { state: "pending", to: "running", at: now + 12_000 });
      return `mock-${now.toString(36)}`;
    },
    async dbPower(id, action) {
      const now = Date.now();
      tickBox(E, now);
      if (!Object.hasOwn(E.rds, id)) throw Object.assign(new Error("DBInstanceNotFound"), { name: "DBInstanceNotFoundFault" });
      E.rds[id] = { ...E.rds[id], ...(action === "stop" ? { state: "stopping", to: "stopped" } : { state: "starting", to: "available" }), at: now + 20_000 };
      return `mock-${now.toString(36)}`;
    },
    async logStreams(group, prefix) {
      const s = svcFromGroup(E, group);
      const now = Date.now();
      return s.tasks.slice(-3).map((t) => ({ name: streamName(s, t), lastEventAt: liveEnd(E, s, t, now) })).filter((x) => !prefix || x.name.startsWith(prefix)).sort((a, b) => b.lastEventAt - a.lastEventAt);
    },
    async logEvents(group, stream, o) {
      const s = svcFromGroup(E, group);
      const t = taskOf(s, stream);
      if (!t) throw Object.assign(new Error("ResourceNotFoundException: stream"), { name: "ResourceNotFoundException" });
      const now = Date.now();
      const end = liveEnd(E, s, t, now);
      const [dir, at] = o.token ? [o.token[0], Number(o.token.slice(2))] : [o.fromHead ? "h" : "t", 0];
      let res: { out: { ts: number; msg: string }[] };
      if (dir === "f") res = scan(s, at + 1, end, 1, o.limit);
      else if (dir === "b") res = scan(s, Math.max(t.start, at - 12 * HOUR), at - 1, -1, o.limit);
      else if (dir === "h") res = scan(s, t.start, end, 1, o.limit);
      else {
        const to = o.end !== undefined ? Math.min(end, o.end - 1) : end;
        res = scan(s, Math.max(t.start, to - 12 * HOUR), to, -1, o.limit);
      }
      const ev = res.out;
      const first = ev[0]?.ts ?? (dir === "b" ? at : end);
      const last = ev[ev.length - 1]?.ts ?? (dir === "f" ? at : end);
      return { events: ev, forward: `f/${last}`, backward: `b/${first}` };
    },
    async filterLogs(group, o) {
      const s = svcFromGroup(E, group);
      const from = o.token ? Number(o.token.slice(2)) : o.start;
      const { out, exhausted } = scan(s, from, Math.min(o.end, Date.now()), 1, o.limit, undefined, cwPattern(o.pattern));
      const last = out[out.length - 1]?.ts;
      const more = out.length >= o.limit || !exhausted;
      const task = s.tasks[s.tasks.length - 1];
      return {
        events: out.map((e) => ({ ...e, stream: streamName(s, s.tasks.find((t) => e.ts >= t.start && (!t.end || e.ts <= t.end)) ?? task) })),
        next: more ? `s/${(last ?? from) + 1}` : undefined,
      };
    },
    probe: (cluster, name, url) => probeIn(E, cluster, name, url),
    async containerEnv(arn) {
      const s = [...E.svcs.values()].find((x) => x.revs.some((r) => r.arn === arn));
      const r = s?.revs.find((x) => x.arn === arn);
      if (!s || !r) throw Object.assign(new Error("ClientException: Unable to describe task definition."), { name: "ClientException" });
      return [{ container: s.name, environment: r.env.environment.map((e) => ({ ...e })), secrets: r.env.secrets.map((e) => ({ ...e })), files: [...r.env.files] }];
    },
    async registerWithEnv(arn, edits) {
      const s = [...E.svcs.values()].find((x) => x.revs.some((r) => r.arn === arn));
      const base = s?.revs.find((x) => x.arn === arn);
      if (!s || !base) throw Object.assign(new Error("ClientException: Unable to describe task definition."), { name: "ClientException" });
      const edit = edits.find((e) => e.container === s.name);
      const revision = Math.max(...s.revs.map((r) => r.revision)) + 1;
      const next: MRev = {
        ...base, revision, arn: base.arn.replace(/:\d+$/, `:${revision}`), registeredAt: Date.now(), imagePresent: true,
        env: { ...base.env, environment: edit ? edit.environment.map((e) => ({ ...e })) : base.env.environment },
      };
      s.revs.push(next);
      return next.arn;
    },
    async registerWithImage(arn, _container, image) {
      const s = [...E.svcs.values()].find((x) => x.revs.some((r) => r.arn === arn));
      const base = s?.revs.find((x) => x.arn === arn);
      if (!s || !base) throw Object.assign(new Error("ClientException: Unable to describe task definition."), { name: "ClientException" });
      const revision = Math.max(...s.revs.map((r) => r.revision)) + 1;
      const tag = image.includes("@") ? undefined : image.split(":").pop();
      s.revs.push({ ...base, revision, arn: base.arn.replace(/:\d+$/, `:${revision}`), registeredAt: Date.now(), imagePresent: true, image, sha: shaFromTag(tag) });
      return s.revs.at(-1)!.arn;
    },
    async readSecret(valueFrom) {
      const ref = parseSecretRef(valueFrom);
      const v = E.secrets.get(ref.kind === "ssm" ? ref.name : ref.secretId);
      if (v === undefined) throw Object.assign(new Error("ResourceNotFoundException: secret not found"), { name: "ResourceNotFoundException" });
      return ref.kind === "secretsmanager" && ref.jsonKey ? jsonKeyValue(v, ref.jsonKey) : v;
    },
    async secretVersion(valueFrom) {
      const ref = parseSecretRef(valueFrom);
      if (!E.secrets.has(secretKey(ref))) {
        if (ref.kind === "ssm") return undefined; // DescribeParameters finds nothing
        throw Object.assign(new Error("ResourceNotFoundException: secret not found"), { name: "ResourceNotFoundException" });
      }
      if (ref.kind === "secretsmanager" && ref.versionId) return ref.versionId;
      return versionLabel(ref, versionOf(E, ref));
    },
    async writeSecret(valueFrom, value, o = {}) {
      const ref = parseSecretRef(valueFrom);
      const key = secretKey(ref);
      if (!E.secrets.has(key)) throw Object.assign(new Error("ResourceNotFoundException: secret not found"), { name: "ResourceNotFoundException" });
      if (ref.kind === "secretsmanager" && (ref.versionStage || ref.versionId)) throw new Error("this reference pins a secret version — a new value would not reach the service; update the secret in AWS and the reference together");
      const cur = versionOf(E, ref);
      if (o.ifVersion !== undefined && o.ifVersion !== versionLabel(ref, cur)) throw new HttpError(409, SECRET_CHANGED);
      E.secrets.set(key, ref.kind === "secretsmanager" && ref.jsonKey ? withJsonKey(E.secrets.get(key)!, ref.jsonKey, value) : value);
      E.versions!.set(key, cur + 1);
      return { version: versionLabel(ref, cur + 1) };
    },
    async readEnvFile(arn) {
      const t = E.files.get(arn);
      if (t === undefined) throw Object.assign(new Error("NoSuchKey: The specified key does not exist."), { name: "NoSuchKey" });
      return { text: t, etag: etagOf(t) };
    },
    async writeEnvFile(arn, text, o = {}) {
      const cur = E.files.get(arn);
      if (cur === undefined) throw Object.assign(new Error("NoSuchKey: The specified key does not exist."), { name: "NoSuchKey" });
      if (o.ifMatch !== undefined && o.ifMatch !== etagOf(cur)) throw new HttpError(409, ENV_FILE_CHANGED);
      E.files.set(arn, text);
      return { etag: etagOf(text) };
    },
    // ---------- create & scale ----------
    async serviceSpec(cluster, service) {
      const s = svcOf(E, envOfCluster(E, cluster) ?? cluster, service);
      const vpc = s.launch === "FARGATE";
      return {
        launchType: s.launch, capacityProviderStrategy: [], platformVersion: vpc ? "LATEST" : undefined, enableExecuteCommand: false,
        network: vpc ? { subnets: s.net?.subnets ?? ["subnet-prod-a", "subnet-prod-b"], securityGroups: s.net?.sgs ?? [PROD_SG[s.name]].filter(Boolean), assignPublicIp: false } : undefined,
        placementConstraints: [], placementStrategy: [], loadBalancers: s.tgArn ? 1 : 0, serviceRegistries: 0, serviceConnect: false,
      };
    },
    async familyInfo(family) {
      if (E.copyFamilies.has(family)) return { consoleCreated: true };
      return [...E.svcs.values()].some((s) => famOf(s) === family) ? { consoleCreated: false } : null;
    },
    async registerCopy(arn, o) {
      const from = [...E.svcs.values()].find((x) => x.revs.some((r) => r.arn === arn));
      const base = from?.revs.find((r) => r.arn === arn);
      if (!from || !base) throw Object.assign(new Error("ClientException: Unable to describe task definition."), { name: "ClientException" });
      const revision = (E.copyFamilies.get(o.family) ?? 0) + 1;
      E.copyFamilies.set(o.family, revision);
      const rev: MRev = {
        arn: `arn:aws:ecs:${E.region}:${ACCT}:task-definition/${o.family}:${revision}`, revision, image: o.image?.image ?? base.image, sha: o.image ? undefined : base.sha,
        registeredAt: Date.now(), imagePresent: true,
        env: { environment: base.env.environment.map((e) => ({ ...e })), secrets: base.env.secrets.map((e) => ({ ...e })), files: [...base.env.files] },
      };
      E.copies.set(rev.arn, { rev, from, cpu: o.cpu ?? from.cpu, memory: o.memory ?? from.memory });
      return rev.arn;
    },
    async createService(spec) {
      const env = envOfCluster(E, spec.cluster);
      if (!env) throw Object.assign(new Error(`ClusterNotFoundException: ${spec.cluster}`), { name: "ClusterNotFoundException" });
      if (E.svcs.has(`${env}/${spec.name}`)) throw Object.assign(new Error("InvalidParameterException: Creation of service was not idempotent."), { name: "InvalidParameterException" });
      const c = E.copies.get(spec.taskDefinition);
      if (!c) throw Object.assign(new Error("ClientException: TaskDefinition not found."), { name: "ClientException" });
      E.copies.delete(spec.taskDefinition);
      const now = Date.now();
      const dep = `ecs-svc/${Math.floor(rnd(`${spec.name}${now}`) * 1e18)}`;
      E.svcs.set(`${env}/${spec.name}`, {
        env, cluster: spec.cluster, name: spec.name, kind: c.from.kind, launch: spec.launchType === "EC2" ? "EC2" : "FARGATE", desired: spec.desired, revs: [c.rev], live: 0,
        deployments: [{
          id: dep, status: "PRIMARY", rolloutState: spec.desired ? "IN_PROGRESS" : "COMPLETED", taskDefinition: c.rev.arn, desired: spec.desired,
          running: 0, pending: spec.desired, failedTasks: 0, createdAt: now, updatedAt: now,
        }],
        healthcheck: c.from.healthcheck, cpu: c.cpu, memory: c.memory, memoryReservation: c.from.memoryReservation, port: c.from.port, rate: c.from.rate,
        tasks: [{ id: hex40(`${spec.name}/${now}/first`).slice(0, 32), start: now + 10_000 }],
        family: c.rev.arn.split("/").pop()!.replace(/:\d+$/, ""), tags: { ...spec.tags },
        net: spec.network ? { subnets: [...spec.network.subnets], sgs: [...spec.network.securityGroups] } : undefined, createDep: dep, bornAt: now,
      });
      return `mock-${now.toString(36)}`;
    },
    async deleteService(cluster, service) {
      const s = svcOf(E, envOfCluster(E, cluster) ?? cluster, service);
      // Like the shipped IAM policy: DeleteService only on services tagged console:created=true.
      if (tagsOf(s)["console:created"] !== "true") throw Object.assign(new Error(`AccessDeniedException: not authorized to perform ecs:DeleteService on ${service}`), { name: "AccessDeniedException" });
      const now = Date.now();
      rawService(E, s, now);
      Object.assign(s, { desired: 0, deletedAt: now, ...(s.desired > 0 ? { stopAt: now } : {}) });
      const last = s.tasks[s.tasks.length - 1];
      last.end ??= now + 4_000;
      return `mock-${now.toString(36)}`;
    },
    async runTask(spec) {
      const s = svcOf(E, envOfCluster(E, spec.cluster) ?? spec.cluster, spec.service);
      if (!s.revs.some((r) => r.arn === spec.taskDefinition)) throw Object.assign(new Error("ClientException: TaskDefinition not found."), { name: "ClientException" });
      // The same client token answers like the first call and starts nothing new (F31).
      const tokens = (E.tokens ??= new Map());
      const seen = spec.clientToken ? tokens.get(`run-task:${spec.clientToken}`) : undefined;
      if (seen?.taskArn) return { taskArn: seen.taskArn, requestId: seen.requestId };
      const now = Date.now();
      const id = hex40(`${spec.service}/run/${now}`).slice(0, 32);
      (s.oneOff ??= []).push({ id, at: now, container: spec.override?.container ?? s.name, command: !!spec.override });
      const res = { taskArn: `arn:aws:ecs:${E.region}:${ACCT}:task/${spec.cluster}/${id}`, requestId: `mock-${now.toString(36)}` };
      if (spec.clientToken) tokens.set(`run-task:${spec.clientToken}`, res);
      return res;
    },
    async hostSpec(id) {
      tickBox(E, Date.now());
      const h = id === BOX_ID && E.box ? { type: "t3a.small", tags: BOX_TAGS } : E.extraHosts.get(id);
      if (!h) throw Object.assign(new Error(`InvalidInstanceID.NotFound: ${id}`), { name: "InvalidInstanceID.NotFound" });
      return {
        id, imageId: "ami-0c1d2e3f4a5b6c7d8", instanceType: h.type, subnetId: "subnet-stg-a", securityGroups: ["sg-stg-box"],
        instanceProfileArn: `arn:aws:iam::${ACCT}:instance-profile/acme-ecs-instance`, hasUserData: true, hasPublicIp: id === BOX_ID, tags: { ...h.tags },
      };
    },
    async launchHosts(from, o) {
      const now = Date.now();
      tickBox(E, now);
      const tokens = (E.tokens ??= new Map());
      const seen = o.clientToken ? tokens.get(`run-instances:${o.clientToken}`) : undefined;
      if (seen?.instanceIds) return { instanceIds: [...seen.instanceIds], requestId: seen.requestId };
      const src = from === BOX_ID && E.box ? { env: "staging", type: "t3a.small" } : E.extraHosts.get(from);
      if (!src) throw Object.assign(new Error(`InvalidInstanceID.NotFound: ${from}`), { name: "InvalidInstanceID.NotFound" });
      // Tagged with the cluster they are for (R23), as on AWS only when the caller says which: without it taggedHosts()
      // can't see them before they register, here as there.
      const tags = o.cluster ? { ...o.tags, "console:cluster": o.cluster } : { ...o.tags };
      // Two launches in the same millisecond still get different instances (the estate's host count tells them apart).
      const seq = E.extraHosts.size;
      const ids = Array.from({ length: o.count }, (_, k) => `i-0${hex40(`${from}/${now}/${seq}/${k}`).slice(0, 16)}`);
      for (const id of ids) {
        E.extraHosts.set(id, { id, env: src.env, name: o.tags.Name ?? id, type: o.instanceType ?? src.type, state: "pending", to: "running", at: now + 15_000, since: now, launchedAt: now, tags: { ...tags } });
      }
      const res = { instanceIds: ids, requestId: `mock-${now.toString(36)}` };
      if (o.clientToken) tokens.set(`run-instances:${o.clientToken}`, { ...res, instanceIds: [...ids] });
      return res;
    },
    async terminateHost(id) {
      const h = E.extraHosts.get(id);
      // Like the shipped IAM policy: TerminateInstances only on instances tagged console:created=true.
      if (!h || h.tags["console:created"] !== "true") throw Object.assign(new Error(`UnauthorizedOperation: not authorized to terminate ${id}`), { name: "UnauthorizedOperation" });
      const now = Date.now();
      Object.assign(h, { state: "shutting-down", to: "terminated", at: now + 10_000 });
      return `mock-${now.toString(36)}`;
    },
    async enabledRegions() {
      return [...MOCK_REGIONS];
    },
    // The console's own task role (mock-names IAM_ROLES), which may do everything it asks about.
    async principal() {
      return IAM_ROLES.tasks.console.arn;
    },
    async simulate(actions) {
      return Object.fromEntries(actions.map((a) => [a, "allowed" as const]));
    },
  };
}

export function mockCi(): Ci {
  return {
    kind: "mock",
    async runs(repo, branch, limit) {
      return buildRuns(repo, Date.now()).filter((m) => !branch || m.run.branch === branch).slice(0, limit).map((m) => m.run);
    },
    async run(repo, id) {
      return findRun(repo, id).run;
    },
    async jobs(repo, runId) {
      return jobsOf(findRun(repo, runId), Date.now());
    },
    async jobLog(repo, jobId) {
      const runId = Math.floor(jobId / 10);
      const m = findRun(repo, runId);
      const job = jobsOf(m, Date.now())[jobId % 10];
      const lines: string[] = [];
      for (const st of job.steps) {
        if (!st.startedAt) break;
        const t0 = Date.parse(st.startedAt);
        lines.push(`${new Date(t0).toISOString()} ##[group]${st.name}`);
        const n = st.name.includes("test") ? 400 : st.name.includes("install") ? 120 : st.name.includes("Build") || st.name.includes("build") ? 200 : 6;
        for (let i = 0; i < n; i++) {
          const ts = new Date(t0 + i * 50).toISOString();
          if (st.name.includes("test")) lines.push(`${ts} ✔ ${pick(["orders", "cart", "pricing", "checkout", "webhooks"], rnd(`${jobId}${i}`))} case ${i + 1} (${(rnd(`${i}`) * 40).toFixed(3)}ms)`);
          else if (st.name.includes("install")) lines.push(`${ts} Progress: resolved ${i * 11}, reused ${i * 10}, downloaded ${i}, added ${i * 9}`);
          else lines.push(`${ts} #${i + 3} [${pick(["deps", "build", "runtime"], rnd(`${i}b`))} ${i}/${n}] RUN step ${i}`);
        }
        if (st.conclusion === "failure") {
          lines.push(`${new Date(t0 + n * 50).toISOString()} ✖ orders rejects an expired discount code (41.2ms)`);
          lines.push(`${new Date(t0 + n * 50).toISOString()}   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 409 !== 200`);
          lines.push(`${new Date(t0 + n * 50).toISOString()} ##[error]Process completed with exit code 1.`);
        }
        lines.push(`${new Date(t0).toISOString()} ##[endgroup]`);
      }
      return lines.join("\n");
    },
    async tests(repo, runId) {
      const m = findRun(repo, runId);
      if (m.run.status !== "completed") return null;
      const kinds = m.jobs.map((j) => j.tests).filter((x): x is string => !!x);
      if (!kinds.length) return null;
      return summarize(kinds.map((k, i) => ({ name: `junit-${k}/${k}.xml`, xml: junitXml(k, !!m.failAt && i === 0) })));
    },
    async rerun(repo, runId, failedOnly) {
      const m = findRun(repo, runId);
      reruns.set(runId, { attempt: m.run.attempt + 1, at: Date.now() + 3_000, failedOnly });
    },
    async commit(repo, sha) {
      for (const branch of BRANCHES) {
        const p = pushes(repo, branch).find((x) => x.sha === sha);
        if (p) return { sha, title: p.title, author: p.author, date: new Date(p.at).toISOString(), url: `https://github.com/${repo}/commit/${sha}` } satisfies CommitInfo;
      }
      return { sha, title: pick(TITLES, rnd(sha)), author: AUTHORS[0], date: new Date(T0).toISOString(), url: `https://github.com/${repo}/commit/${sha}` };
    },
    async compare(repo, base, head) {
      const isBranch = (ref: string) => BRANCHES.includes(ref);
      const branchOf = (ref: string) => (isBranch(ref) ? ref : pushes(repo, STAGING_BRANCH).some((p) => p.sha === ref) ? STAGING_BRANCH : PROD_BRANCH);
      const a = resolveRef(repo, base)?.push;
      const b = resolveRef(repo, head)?.push;
      // Commits on head's branch after base, up to head — what a three-dot compare lists — and the files they touched.
      const range = a && b ? pushes(repo, branchOf(head)).filter((p) => p.at > a.at && p.at <= b.at).sort((x, y) => x.at - y.at) : [];
      const commits = range.map((p) => ({ sha: p.sha, title: p.title, author: p.author, date: new Date(p.at).toISOString() }));
      const behind = a && b ? pushes(repo, branchOf(base)).filter((p) => p.at > b.at && p.at <= a.at).length : 0;
      const all = [...new Set(range.flatMap((p) => filesOf(repo, branchOf(head), p)))];
      return { aheadBy: commits.length, behindBy: behind, files: all.slice(0, COMPARE_FILE_CAP), commits, complete: all.length <= COMPARE_FILE_CAP };
    },
    // R25: the migrations directory at a ref — the base migrations plus every one pushed on that branch up to the ref.
    // Any other path, or an unknown ref, is not found (null).
    async listDir(repo, path, ref) {
      const dir = `${path.replace(/^\/+|\/+$/g, "")}/`;
      const at = dir === MIGRATIONS && hasMigrations(repo) ? resolveRef(repo, ref) : undefined;
      if (!at) return null;
      const names = new Set(BASE_MIGRATIONS);
      for (const p of pushes(repo, at.branch)) {
        if (p.at > at.push.at) continue;
        for (const f of filesOf(repo, at.branch, p)) if (f.startsWith(MIGRATIONS)) names.add(f.slice(MIGRATIONS.length).split("/")[0]);
      }
      return [...names].sort().map((name) => ({ name, sha: hex40(`${repo}:${MIGRATIONS}${name}`) }));
    },
    async repoExists(repo) {
      return DEMO.some((d) => d.repo === repo);
    },
  };
}

