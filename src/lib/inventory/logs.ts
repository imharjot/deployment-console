// CloudWatch Logs log groups as the cloud map sees them, pure (audit §6 A.2 #9): SDK-shaped DescribeLogGroups,
// DescribeSubscriptionFilters and ListTagsForResource answers in; one node per group out, with what writes to it and
// where it streams. The provider (../server/providers/logs.ts) and its simulation feed the same functions. No AWS calls.
//
// Key = logGroupArn (DescribeLogGroups returns it without ":*"); the name and the ":*" form are aliases, so every way a
// configuration names a group resolves. Links:
// - subscription filters → their destination (event), and the role CloudWatch Logs assumes to deliver;
// - who writes here: ECS services from their task definitions' awslogs groups (config; the provider passes them in its
//   home-region run only, CC-19), and AWS's naming conventions (mentioned): /aws/lambda/<function>,
//   /aws/rds/instance/<id>/<log>, /aws/rds/cluster/<id>/<log>, /aws/codebuild/<project>, /aws/eks/<cluster>/cluster and
//   API-Gateway-Execution-Logs_<api id>/<stage> — each as an ARN in the group's own region, so it resolves there only;
// - its KMS key (encrypts).
// Container Insights and vended groups (/aws/ecs/containerinsights/…, /aws/vendedlogs/…) are hidden: listed and
// resolvable, never drawn. Health: a group that never expires and holds more than 10 GiB is a warning.
import { arnBase, arnOf, partitionOf } from "./arn.ts";
import { arnName, assumesLink, clip, encryptsLink, enrichmentOf, fmtBytes, fmtTime, kmsKeyRef, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Link, ProviderResult, Resource } from "./types.ts";

// ---------- raw shapes (the SDK's field names) ----------

export interface RawLogGroup {
  logGroupName?: string;
  logGroupArn?: string; // without ":*"
  arn?: string; // with ":*"
  creationTime?: number; // epoch ms
  retentionInDays?: number; // undefined = never expire
  metricFilterCount?: number;
  storedBytes?: number;
  kmsKeyId?: string;
  dataProtectionStatus?: string;
  logGroupClass?: string; // STANDARD | INFREQUENT_ACCESS | DELIVERY
  deletionProtectionEnabled?: boolean;
}
export interface RawSubscriptionFilter {
  filterName?: string;
  logGroupName?: string;
  filterPattern?: string;
  destinationArn?: string;
  roleArn?: string;
  distribution?: string;
  creationTime?: number;
}

// One ECS service's containers that log through awslogs (from its task definition), with the service's map key.
export interface EcsLogUse {
  service: string; // the ECS service's key (keys.ecsService, region-aware)
  label: string; // "acme-production/api"
  region: string; // where the service (and its log group) lives
  taskDef?: string; // "api-production:120"
  containers: { name: string; logGroup?: string; logRegion?: string }[]; // logRegion: awslogs-region, when not the service's
}

export const NEVER_EXPIRE_WARN_BYTES = 10 * 1024 ** 3;
const HIDDEN = [/^\/aws\/ecs\/containerinsights\//, /^\/aws\/vendedlogs\//];
export const isHiddenGroup = (name: string) => HIDDEN.some((re) => re.test(name));

// ---------- naming conventions ----------

const REGION_RE = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})\.(.+)$/; // Lambda@Edge replicas: "/aws/lambda/us-east-1.<function>"

// What AWS's naming conventions say writes to a group, as a reference in the group's region and account.
export function conventionWriter(name: string, region: string, account: string | undefined): { ref: string; what: string } | undefined {
  if (!account) return undefined;
  const p = partitionOf(region);
  let x: RegExpExecArray | null;
  if ((x = /^\/aws\/lambda\/([^/]+)$/.exec(name))) {
    const edge = REGION_RE.exec(x[1]);
    const [fnRegion, fn] = edge ? [edge[1], edge[2]] : [region, x[1]];
    return { ref: `arn:${partitionOf(fnRegion)}:lambda:${fnRegion}:${account}:function:${fn}`, what: `Lambda function ${fn}${edge ? ` (replica of ${fnRegion})` : ""}` };
  }
  if ((x = /^\/aws\/rds\/instance\/([^/]+)\/[^/]+$/.exec(name))) return { ref: arnOf.rdsDb(region, account, x[1]), what: `database instance ${x[1]}` };
  if ((x = /^\/aws\/rds\/cluster\/([^/]+)\/[^/]+$/.exec(name))) return { ref: arnOf.rdsCluster(region, account, x[1]), what: `database cluster ${x[1]}` };
  if ((x = /^\/aws\/codebuild\/([^/]+)$/.exec(name))) return { ref: arnOf.codebuildProject(region, account, x[1]), what: `CodeBuild project ${x[1]}` };
  if ((x = /^\/aws\/eks\/([^/]+)\/cluster$/.exec(name))) return { ref: `arn:${p}:eks:${region}:${account}:cluster/${x[1]}`, what: `EKS cluster ${x[1]}` };
  if ((x = /^API-Gateway-Execution-Logs_([a-z0-9]+)\/(.+)$/.exec(name))) return { ref: `arn:${p}:apigateway:${region}::/restapis/${x[1]}`, what: `REST API ${x[1]} (stage ${x[2]})` };
  return undefined;
}

// ---------- the groups as map resources ----------

export interface LogsInput {
  region: string;
  accountId?: string;
  now: number;
  groups: RawLogGroup[];
  // Per group name; a missing entry = not read (the state says why: capped, skipped, denied, error).
  subscriptions?: Record<string, RawSubscriptionFilter[] | undefined>;
  subState?: Record<string, EnrichState>;
  tags?: Record<string, Record<string, string> | undefined>;
  tagState?: Record<string, EnrichState>;
  ecs?: EcsLogUse[]; // the home-region run only (CC-19)
}

const retention = (days: number | undefined) => (days === undefined ? "never expires" : days === 1 ? "1 day" : `${days.toLocaleString("en-US")} days`);
const consoleUrl = (region: string, name: string) =>
  `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(encodeURIComponent(name)).replace(/%/g, "$")}`;
const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);

export function logGroupResults(i: LogsInput): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const keyOf = new Map<string, string>(); // name → key, for the ECS links
  for (const g of i.groups) {
    const name = g.logGroupName;
    if (!name) continue;
    const account = (g.logGroupArn ?? g.arn)?.split(":")[4] || i.accountId;
    const key = g.logGroupArn || (g.arn ? arnBase(g.arn) : account ? arnOf.logGroup(i.region, account, name) : undefined);
    if (!key) continue;
    keyOf.set(name, key);
    const hidden = isHiddenGroup(name);
    const subs = own(i.subscriptions, name);
    const tags = own(i.tags, name);
    const neverExpires = g.retentionInDays === undefined || g.retentionInDays === null;
    const big = neverExpires && (g.storedBytes ?? 0) > NEVER_EXPIRE_WARN_BYTES;

    for (const s of subs ?? []) {
      if (!s.destinationArn) continue;
      const label = `subscription ${s.filterName ?? ""}`.trim();
      links.push({ from: key, to: arnBase(s.destinationArn), kind: "event", label, evidence: `log group subscription filter ${s.filterName ?? ""}${s.filterPattern ? ` (pattern ${clip(s.filterPattern, 60)})` : " (every event)"}`.replace(/ +/g, " ") });
      links.push(...assumesLink(key, s.roleArn, `delivers ${label}`, `subscription filter ${s.filterName ?? ""} roleArn`.replace(/ +/g, " ")));
    }
    links.push(...encryptsLink(kmsKeyRef(g.kmsKeyId, i.region, account), key, "log data", "log group kmsKeyId"));
    const writer = conventionWriter(name, i.region, account);
    if (writer) links.push({ from: writer.ref, to: key, kind: "logs", label: "logs (naming convention)", evidence: `log group name ${name} (AWS naming convention for ${writer.what})`, confidence: "mentioned" });

    const subState = own(i.subState, name) ?? (subs ? "ok" : undefined);
    const tagState = own(i.tagState, name) ?? (tags ? "ok" : undefined);
    const enrichment = enrichmentOf({ subscriptions: subState, tags: tagState });
    resources.push({
      key, kind: "log-group", provider: "logs", name, region: i.region, ...tagsOf(tags),
      health: big ? "warning" : "ok",
      ...(big ? { healthReason: `never expires and holds ${fmtBytes(g.storedBytes)} — set a retention period (storage is billed per GB-month)` } : {}),
      props: props([
        { label: "Retention", value: retention(g.retentionInDays) },
        { label: "Stored", value: g.storedBytes !== undefined ? fmtBytes(g.storedBytes) : undefined },
        { label: "Class", value: g.logGroupClass && g.logGroupClass !== "STANDARD" ? g.logGroupClass.toLowerCase().replace(/_/g, " ") : undefined },
        { label: "KMS key", value: g.kmsKeyId ? arnName(g.kmsKeyId) : undefined },
        { label: "Metric filters", value: g.metricFilterCount ? String(g.metricFilterCount) : undefined },
        { label: "Subscriptions", value: subs ? (subs.length ? clip(subs.map((s) => `${s.filterName ?? "?"} → ${arnName(s.destinationArn) || "?"}`).join(", "), 200) : "none") : unread("subscription filters", subState) },
        { label: "Data protection", value: g.dataProtectionStatus ? g.dataProtectionStatus.toLowerCase() : undefined },
        g.deletionProtectionEnabled && { label: "Deletion protection", value: "on" },
        { label: "Created", value: g.creationTime ? fmtTime(g.creationTime) : undefined },
      ]),
      aliases: [name, `${key}:*`],
      ...(hidden ? { hidden: true } : {}),
      consoleUrl: consoleUrl(i.region, name),
      ...(g.creationTime ? { createdAt: g.creationTime } : {}),
      observedAt: i.now,
      ...(enrichment ? { enrichment } : {}),
    });
  }

  // ECS services → the groups their containers log to (the task definition's awslogs configuration), in the region
  // awslogs-region names (else the service's).
  for (const u of i.ecs ?? []) {
    const groups = new Map<string, { region: string; group: string; containers: string[] }>();
    for (const c of u.containers) {
      if (!c.logGroup) continue;
      const region = c.logRegion || u.region;
      const k = `${region}|${c.logGroup}`;
      groups.set(k, { region, group: c.logGroup, containers: [...(groups.get(k)?.containers ?? []), c.name] });
    }
    for (const { region, group, containers } of groups.values()) {
      const to = (region === i.region ? keyOf.get(group) : undefined) ?? (i.accountId ? arnOf.logGroup(region, i.accountId, group) : undefined);
      if (!to) continue;
      links.push({
        from: u.service, to, kind: "logs", label: containers.length === 1 ? `container ${containers[0]}` : `containers ${containers.join(", ")}`,
        evidence: `task definition ${u.taskDef ?? u.label} (awslogs log group)`,
      });
    }
  }
  return { resources, links, mentions: [] };
}

// ---------- detail ----------

export interface RawLogStream { logStreamName?: string; lastEventTimestamp?: number; firstEventTimestamp?: number; creationTime?: number }

// The newest streams as table rows: stream, last event, first event.
export const streamRows = (streams: RawLogStream[]): string[][] =>
  [...streams]
    .sort((a, b) => (b.lastEventTimestamp ?? b.creationTime ?? 0) - (a.lastEventTimestamp ?? a.creationTime ?? 0))
    .map((s) => [s.logStreamName ?? "?", fmtTime(s.lastEventTimestamp), fmtTime(s.firstEventTimestamp ?? s.creationTime)]);

// Subscription filters as table rows: filter, destination, pattern (shortened).
export const subscriptionRows = (subs: RawSubscriptionFilter[]): string[][] =>
  subs.map((s) => [s.filterName ?? "?", s.destinationArn ?? "?", s.filterPattern ? clip(s.filterPattern, 80) : "(every event)"]);
