// The catch-all's mapper, pure: every other resource the account holds — rows from Resource Explorer, the Tagging API,
// AWS Config and Cloud Control — as generic resources (kind "aws-resource"), so nothing in the account is invisible
// (audit §6 B.1, B.3, B.5). infer() then drops the rows a first-class provider already shows, counts sub-objects and
// hides table-only types (B.4).
//
// What is read from each source, and nothing else: an ARN, a type, a region, an account, tags, a report time, and —
// from AWS Config — relationships. Resource Explorer's other properties, Config's `configuration` and Cloud Control's
// resource models are never read (they can hold anything, secrets included).
import { arnBase, arnName, arnType, parseArn } from "./arn.ts";
import { infoOf } from "./aws-services.ts";
import type { Link, ProviderResult, Resource } from "./types.ts";

export type GenericSource = "resource-explorer" | "tagging" | "config" | "cloudcontrol";

// One row from any source, normalised.
export interface GenericRow {
  arn: string; // or "cloudcontrol:<region>/<type>/<identifier>" when Cloud Control gives no ARN
  source: GenericSource;
  type?: string; // Resource Explorer spelling ("sagemaker:model"); from the ARN when absent
  region?: string; // "global" for global resources
  account?: string;
  name?: string;
  tags?: Record<string, string>;
  lastReported?: number;
  vpcId?: string;
  subnetIds?: string[];
  securityGroups?: string[];
}

// ---------- Resource Explorer (ListResources) ----------

export interface RawExplorerResource {
  Arn?: string;
  ResourceType?: string;
  Region?: string;
  OwningAccountId?: string;
  Service?: string;
  LastReportedAt?: Date | string;
  Properties?: { Name?: string; LastReportedAt?: Date | string; Data?: unknown }[];
}

const time = (v: Date | string | undefined) => (v instanceof Date ? v.getTime() : typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined);

// Tags as [{ Key, Value }] (Resource Explorer, the Tagging API) or [{ key, value }] (AWS Config); own properties only.
function tagsOf(data: unknown): Record<string, string> | undefined {
  if (!Array.isArray(data)) return undefined;
  const out: Record<string, string> = {};
  for (const t of data) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const k = Object.hasOwn(o, "Key") ? o.Key : Object.hasOwn(o, "key") ? o.key : undefined;
    const v = Object.hasOwn(o, "Value") ? o.Value : Object.hasOwn(o, "value") ? o.value : "";
    if (typeof k === "string" && k && typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function fromExplorer(items: RawExplorerResource[]): GenericRow[] {
  const out: GenericRow[] = [];
  for (const x of items ?? []) {
    if (typeof x?.Arn !== "string" || !x.Arn.startsWith("arn:")) continue;
    const tags = tagsOf(x.Properties?.find((p) => p?.Name === "tags")?.Data);
    out.push({
      arn: x.Arn, source: "resource-explorer", type: typeof x.ResourceType === "string" && x.ResourceType ? x.ResourceType : undefined,
      region: typeof x.Region === "string" && x.Region ? x.Region : undefined, account: typeof x.OwningAccountId === "string" ? x.OwningAccountId : undefined,
      tags, lastReported: time(x.LastReportedAt),
    });
  }
  return out;
}

// ---------- the Tagging API (GetResources) ----------

export interface RawTagMapping {
  ResourceARN?: string;
  Tags?: { Key?: string; Value?: string }[];
}

// `region`: where the call was made — an S3 bucket's ARN has none, and the Tagging API lists a bucket in its own region.
export function fromTagging(items: RawTagMapping[], region: string): GenericRow[] {
  const out: GenericRow[] = [];
  for (const x of items ?? []) {
    const p = typeof x?.ResourceARN === "string" ? parseArn(x.ResourceARN) : undefined;
    if (!p) continue;
    out.push({ arn: x.ResourceARN!, source: "tagging", region: p.region || (p.service === "s3" ? region : "global"), account: p.account || undefined, tags: tagsOf(x.Tags) });
  }
  return out;
}

// ---------- AWS Config (SelectResourceConfig) ----------

// The only columns the console selects (never `configuration`).
export const CONFIG_SELECT = "SELECT resourceId, resourceName, resourceType, arn, awsRegion, accountId, tags, relationships, configurationItemCaptureTime";

// CloudFormation / Config type → Resource Explorer spelling: "AWS::Glue::Database" → "glue:database",
// "AWS::EC2::NetworkInterface" → "ec2:network-interface".
const CFN_SERVICE: Record<string, string> = {
  elasticloadbalancingv2: "elasticloadbalancing", certificatemanager: "acm", logs: "logs", cloudwatch: "cloudwatch", stepfunctions: "states",
  efs: "elasticfilesystem", elasticsearch: "es", opensearchservice: "es", msk: "kafka", amazonmq: "mq", kinesisfirehose: "firehose",
  cognito: "cognito-idp", wafv2: "wafv2", servicediscovery: "servicediscovery", apigatewayv2: "apigateway", events: "events",
};
const CFN_TYPE: Record<string, string> = {
  "AWS::RDS::DBInstance": "rds:db", "AWS::RDS::DBCluster": "rds:cluster", "AWS::RDS::DBSubnetGroup": "rds:subgrp", "AWS::RDS::DBParameterGroup": "rds:pg",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "elasticloadbalancing:loadbalancer/app", "AWS::ElasticLoadBalancingV2::TargetGroup": "elasticloadbalancing:targetgroup",
  "AWS::ElasticLoadBalancing::LoadBalancer": "elasticloadbalancing:loadbalancer", "AWS::EC2::EIP": "ec2:elastic-ip", "AWS::EC2::NatGateway": "ec2:natgateway",
  "AWS::EC2::VPCEndpoint": "ec2:vpc-endpoint", "AWS::EC2::VPCPeeringConnection": "ec2:vpc-peering-connection", "AWS::EC2::VPC": "ec2:vpc",
  "AWS::ElastiCache::ReplicationGroup": "elasticache:replicationgroup", "AWS::ElastiCache::CacheCluster": "elasticache:cluster",
  "AWS::StepFunctions::StateMachine": "states:stateMachine", "AWS::Logs::LogGroup": "logs:log-group", "AWS::SNS::Topic": "sns:topic", "AWS::SQS::Queue": "sqs:queue",
  "AWS::S3::Bucket": "s3:bucket", "AWS::ApiGateway::RestApi": "apigateway:restapis", "AWS::ApiGatewayV2::Api": "apigateway:apis",
  "AWS::CertificateManager::Certificate": "acm:certificate", "AWS::AutoScaling::AutoScalingGroup": "autoscaling:autoScalingGroup",
};
export function typeFromCfn(t: string): string {
  if (Object.hasOwn(CFN_TYPE, t)) return CFN_TYPE[t];
  const m = /^AWS::([A-Za-z0-9]+)::([A-Za-z0-9]+)$/.exec(t);
  if (!m) return t.toLowerCase();
  const svc = m[1].toLowerCase();
  const kebab = m[2].replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase();
  return `${Object.hasOwn(CFN_SERVICE, svc) ? CFN_SERVICE[svc] : svc}:${kebab}`;
}

interface ConfigItem {
  resourceId?: string;
  resourceName?: string;
  resourceType?: string;
  arn?: string;
  awsRegion?: string;
  accountId?: string;
  tags?: unknown;
  relationships?: { resourceType?: string; resourceId?: string; resourceName?: string; relationshipName?: string }[];
  configurationItemCaptureTime?: string;
}

// Rows plus the relationships Config records: its VPC, subnets and security groups become the resource's network fields;
// "is attached to" / "is associated with" anything else becomes a Link ("uses").
export function fromConfig(results: string[], ctx: { region: string; account?: string }): { rows: GenericRow[]; links: Link[] } {
  const rows: GenericRow[] = [];
  const links: Link[] = [];
  const ec2Arn = (kind: string, id: string, region: string, account: string) => `arn:aws:ec2:${region}:${account}:${kind}/${id}`;
  for (const line of results ?? []) {
    let item: ConfigItem;
    try {
      item = JSON.parse(line) as ConfigItem;
    } catch {
      continue;
    }
    if (!item || typeof item.arn !== "string" || !item.arn.startsWith("arn:")) continue;
    const region = typeof item.awsRegion === "string" && item.awsRegion ? item.awsRegion : ctx.region;
    const account = typeof item.accountId === "string" ? item.accountId : ctx.account;
    const row: GenericRow = {
      arn: item.arn, source: "config", type: typeof item.resourceType === "string" ? typeFromCfn(item.resourceType) : undefined, region, account,
      name: typeof item.resourceName === "string" && item.resourceName ? item.resourceName : undefined, tags: tagsOf(item.tags),
      lastReported: time(item.configurationItemCaptureTime),
    };
    for (const rel of Array.isArray(item.relationships) ? item.relationships : []) {
      const id = typeof rel?.resourceId === "string" ? rel.resourceId : undefined;
      const name = String(rel?.relationshipName ?? "").toLowerCase();
      if (!id) continue;
      if (rel.resourceType === "AWS::EC2::VPC" && name.startsWith("is contained in")) row.vpcId = id;
      else if (rel.resourceType === "AWS::EC2::Subnet") row.subnetIds = [...new Set([...(row.subnetIds ?? []), id])];
      else if (rel.resourceType === "AWS::EC2::SecurityGroup" && name.startsWith("is associated with")) row.securityGroups = [...new Set([...(row.securityGroups ?? []), id])];
      else if (name.startsWith("is attached to") || name.startsWith("is associated with")) {
        const to = id.startsWith("arn:") ? id : /^AWS::EC2::(Instance|Volume)$/.test(rel.resourceType ?? "") && account
          ? ec2Arn(rel.resourceType === "AWS::EC2::Instance" ? "instance" : "volume", id, region, account)
          : rel.resourceName || id;
        links.push({ from: arnBase(item.arn), to, kind: "uses", evidence: `AWS Config: ${rel.relationshipName}` });
      }
    }
    rows.push(row);
  }
  return { rows, links };
}

// ---------- Cloud Control (ListResources, opt-in types) ----------

// Only the identifier and, when the model carries one, the ARN.
export function fromCloudControl(typeName: string, items: { Identifier?: string; Properties?: string }[], ctx: { region: string; account?: string }): GenericRow[] {
  const out: GenericRow[] = [];
  for (const x of items ?? []) {
    if (typeof x?.Identifier !== "string" || !x.Identifier) continue;
    let arn: string | undefined;
    try {
      const props = x.Properties ? (JSON.parse(x.Properties) as Record<string, unknown>) : undefined;
      const a = props && Object.hasOwn(props, "Arn") ? props.Arn : undefined;
      if (typeof a === "string" && a.startsWith("arn:")) arn = a;
    } catch {
      /* no ARN */
    }
    out.push({ arn: arn ?? `cloudcontrol:${ctx.region}/${typeName}/${x.Identifier}`, source: "cloudcontrol", type: typeFromCfn(typeName), region: ctx.region, account: ctx.account, name: x.Identifier });
  }
  return out;
}

// ---------- rows → resources ----------

export const consoleLink = (key: string) =>
  key.startsWith("arn:")
    ? `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(key)}`
    : `https://console.aws.amazon.com/resource-explorer/home#/search?query=${encodeURIComponent(key.split("/").pop() ?? key)}`;

const FOUND_BY: Record<GenericSource, string> = { "resource-explorer": "Resource Explorer", tagging: "Tagging API", config: "AWS Config", cloudcontrol: "Cloud Control" };
const day = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function genericResource(row: GenericRow, o: { accountId?: string; now: number }): Resource {
  const key = row.arn.startsWith("arn:") ? arnBase(row.arn) : row.arn;
  const p = parseArn(key);
  const type = row.type || (p ? arnType(p) : "unknown");
  const info = infoOf(type);
  const region = row.region || p?.region || "global";
  const account = row.account || p?.account || undefined;
  const foreign = account && o.accountId && account !== o.accountId ? account : undefined;
  // Sub-objects are only counted (infer drops them): no props to carry.
  const props: Resource["props"] = info.visibility === "drop" ? [] : [
    { label: "Service", value: info.service.label }, { label: "Type", value: `${info.label} (${type})` }, { label: "ARN", value: key, mono: true },
    { label: "Region", value: region }, { label: "Found by", value: FOUND_BY[row.source] },
    ...(row.lastReported ? [{ label: "Last reported", value: day(row.lastReported) }] : []),
    ...(foreign ? [{ label: "Account", value: foreign, mono: true }] : []),
  ];
  const r: Resource = {
    key, kind: "aws-resource", provider: "catchall", name: row.name || (p ? arnName(p, row.tags) : key), region, tags: { ...(row.tags ?? {}) }, health: "unknown",
    healthReason: "No dedicated reader for this type yet", props, service: info.service.label, resourceType: type, category: info.category, source: row.source,
    consoleUrl: consoleLink(key), observedAt: o.now,
  };
  if (info.visibility !== "map") r.hidden = true;
  if (foreign) r.account = foreign;
  if (row.vpcId) r.vpcId = row.vpcId;
  if (row.subnetIds?.length) r.subnetIds = row.subnetIds;
  if (row.securityGroups?.length) r.securityGroups = row.securityGroups;
  if (row.source === "cloudcontrol") r.tagsUnread = true; // Cloud Control lists no tags
  return r;
}

// Rows of every source, one resource per key: the first source that listed it wins (Resource Explorer first), tags
// and network fields are unions.
export function catchallResult(rows: GenericRow[], o: { accountId?: string; now: number; links?: Link[] }): ProviderResult {
  const byKey = new Map<string, GenericRow>();
  for (const row of rows) {
    const key = row.arn.startsWith("arn:") ? arnBase(row.arn) : row.arn;
    const had = byKey.get(key);
    if (!had) byKey.set(key, { ...row });
    else
      byKey.set(key, {
        ...had, type: had.type ?? row.type, name: had.name ?? row.name, region: had.region ?? row.region, lastReported: had.lastReported ?? row.lastReported,
        tags: { ...(row.tags ?? {}), ...(had.tags ?? {}) }, vpcId: had.vpcId ?? row.vpcId,
        subnetIds: [...new Set([...(had.subnetIds ?? []), ...(row.subnetIds ?? [])])], securityGroups: [...new Set([...(had.securityGroups ?? []), ...(row.securityGroups ?? [])])],
      });
  }
  const resources = [...byKey.values()].map((row) => genericResource(row, o)).sort((a, b) => a.key.localeCompare(b.key));
  return { resources, links: o.links ?? [], mentions: [] };
}
