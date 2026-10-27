// Cloud map inference, pure (no AWS calls, no server-only) so node:test covers it: merges what every provider reported
// into one Resource per key, folds the catch-all's generic rows into the first-class resources they duplicate, then
// turns Links, Mentions, security-group rules and CloudFormation tags into Edges.
//
// Trust boundary: Mention.refs hold raw configuration values (env var values, connection strings, origin domains).
// They are only *matched* here, on the server. Nothing derived from a ref's value leaves this module except the key of
// the resource it named; evidence comes from Mention.via (the variable's name), never from the value. Two exceptions,
// both identifiers rather than values: a Link target nobody in the account answers to becomes an `external` node (its
// hostname — Links carry configuration: DNS records, origins, targets), and an ARN of another account or region becomes
// a `reference` node (the ARN without a secret's JSON key / stage / version suffix).
//
// Scope (R14, CC-6): an ARN resolves only inside its own partition, account and region. The console's short keys
// (rds:, elb:, elasticache:, ec2:, ecs:service/) are tried only for the console's own account, with "@<region>" outside
// the home region, and a hit by name or alias must live in the ARN's region and account.
import { inferConnections, stageIdOf, type NodeRef, type SgRule } from "../discover.ts";
import { arnBase, arnName, arnType, parseArn, type ParsedArn } from "./arn.ts";
import { infoOf } from "./aws-services.ts";
import {
  CATEGORY_ORDER, categoryOf, isSupport, keys, type Category, type Edge, type EdgeKind, type EnrichState, type Facts, type Link, type Mention,
  type ProviderResult, type Resource, type ResourceKind, type Routing, type SecurityGroupFacts,
} from "./types.ts";

export type { SgRule };

// ---------- merging resources ----------

const blank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const union = (a?: string[], b?: string[]) => {
  const out = [...new Set([...(a ?? []), ...(b ?? [])].filter((x) => typeof x === "string" && x))];
  return out.length ? out : undefined;
};
const later = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

// Defensive copy of what a provider handed over: required fields present, inventory-only fields (env, protectedBy,
// envWhy, idle, notes, slim) dropped, facts and enrichment states kept only when well-formed.
const FACT = (v: unknown) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === "string"));
const ENRICH = new Set<EnrichState>(["ok", "skipped", "denied", "error", "capped"]);
const CATEGORIES = new Set<string>(CATEGORY_ORDER);
const SOURCES = new Set<string>(["provider", "resource-explorer", "tagging", "config", "cloudcontrol", "reference"]);
const oneOf = <T extends string>(set: Set<string>, v: unknown): T | undefined => (typeof v === "string" && set.has(v) ? (v as T) : undefined);
function cleanFacts(f: unknown): Facts | undefined {
  if (!f || typeof f !== "object" || Array.isArray(f)) return undefined;
  const out: Facts = {};
  for (const [k, v] of Object.entries(f)) if (FACT(v)) out[k] = Array.isArray(v) ? [...v] : (v as string | number | boolean);
  return Object.keys(out).length ? out : undefined;
}
function cleanEnrichment(e: unknown): Record<string, EnrichState> | undefined {
  if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
  const out: Record<string, EnrichState> = {};
  for (const [k, v] of Object.entries(e)) if (ENRICH.has(v as EnrichState)) out[k] = v as EnrichState;
  return Object.keys(out).length ? out : undefined;
}
function clean(r: Resource): Resource {
  return {
    key: r.key, kind: r.kind, provider: r.provider, name: r.name ?? "", region: r.region || "global", tags: { ...(r.tags ?? {}) },
    health: r.health ?? "unknown", healthReason: r.healthReason, props: [...(r.props ?? [])], vpcId: r.vpcId, subnetIds: union(r.subnetIds),
    securityGroups: union(r.securityGroups), endpoints: union(r.endpoints), aliases: union(r.aliases), envHint: r.envHint, lastActivityAt: r.lastActivityAt,
    consoleUrl: r.consoleUrl, createdAt: r.createdAt, lastModified: r.lastModified,
    parent: r.parent || undefined, service: r.service || undefined, resourceType: r.resourceType || undefined,
    category: oneOf<Category>(CATEGORIES, r.category), source: oneOf<NonNullable<Resource["source"]>>(SOURCES, r.source),
    hidden: r.hidden === true || undefined, facts: cleanFacts(r.facts), tagsUnread: r.tagsUnread === true || undefined, account: r.account || undefined,
    observedAt: r.observedAt, enrichment: cleanEnrichment(r.enrichment),
  };
}

// Two reports of the same key: later non-empty fields win; tags, props (by label), networks, endpoints and aliases
// are unions; the most recent activity/modification wins.
// - CC-5: when a later report's kind differs from the first one's, the first report is the owner: its kind, provider,
//   name and region stay (a stray report can't turn an RDS database into a "vpc" resource in region "global"), and so
//   do the fields that say what it is — service, resourceType, category, source — so a generic Resource Explorer row
//   merged into a first-class resource can't move it to the "other" column or relabel it.
// - facts merge key by key; enrichment states too; hidden only when every report says hidden; tags count as unread
//   when any report couldn't read them (protection fails closed, R01).
export function mergeResource(a: Resource, b: Resource): Resource {
  const pick = <T,>(x: T, y: T): T => (blank(y) ? x : y);
  const own = !b.kind || !a.kind || a.kind === b.kind;
  const props = [...a.props];
  for (const p of b.props ?? []) {
    const i = props.findIndex((x) => x.label === p.label);
    if (i >= 0) props[i] = p;
    else props.push(p);
  }
  const bh = !!b.health && b.health !== "unknown";
  const facts = a.facts || b.facts ? { ...(a.facts ?? {}), ...(b.facts ?? {}) } : undefined;
  const enrichment = a.enrichment || b.enrichment ? { ...(a.enrichment ?? {}), ...(b.enrichment ?? {}) } : undefined;
  return {
    key: a.key,
    kind: own ? pick(a.kind, b.kind) : a.kind,
    provider: own ? pick(a.provider, b.provider) : a.provider,
    name: own ? pick(a.name, b.name) : a.name,
    region: own ? pick(a.region, b.region) : a.region,
    tags: { ...a.tags, ...(b.tags ?? {}) },
    health: bh ? b.health : a.health,
    healthReason: bh ? (b.healthReason ?? (a.health === b.health ? a.healthReason : undefined)) : a.healthReason,
    props,
    vpcId: pick(a.vpcId, b.vpcId),
    subnetIds: union(a.subnetIds, b.subnetIds),
    securityGroups: union(a.securityGroups, b.securityGroups),
    endpoints: union(a.endpoints, b.endpoints),
    aliases: union(a.aliases, b.aliases),
    envHint: pick(a.envHint, b.envHint),
    lastActivityAt: later(a.lastActivityAt, b.lastActivityAt),
    consoleUrl: pick(a.consoleUrl, b.consoleUrl),
    createdAt: pick(a.createdAt, b.createdAt),
    lastModified: later(a.lastModified, b.lastModified),
    parent: pick(a.parent, b.parent),
    service: own ? pick(a.service, b.service) : a.service,
    resourceType: own ? pick(a.resourceType, b.resourceType) : a.resourceType,
    category: own ? pick(a.category, b.category) : a.category,
    source: own ? pick(a.source, b.source) : a.source,
    hidden: a.hidden && b.hidden ? true : undefined,
    facts: facts && Object.keys(facts).length ? facts : undefined,
    tagsUnread: a.tagsUnread || b.tagsUnread ? true : undefined,
    account: pick(a.account, b.account),
    observedAt: later(a.observedAt, b.observedAt),
    enrichment: enrichment && Object.keys(enrichment).length ? enrichment : undefined,
  };
}

export function mergeResources(list: Resource[]): Resource[] {
  const m = new Map<string, Resource>();
  for (const r of list) {
    if (!r?.key || !r.kind) continue;
    const had = m.get(r.key);
    m.set(r.key, had ? mergeResource(had, clean(r)) : clean(r));
  }
  return [...m.values()].map((r) => (r.name ? r : { ...r, name: r.key }));
}

// Last line of defence before a resource leaves the server: a prop that looks like a URL with credentials
// ("postgres://app:secret@db…") has its password masked, whatever a provider put there.
// user:pass@ and a lone token@ (https://ghp_x@github.com/…) in URLs.
const CREDS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/i;
export function scrubProps(r: Resource): Resource {
  if (!r.props.some((p) => CREDS.test(p.value))) return r;
  return { ...r, props: r.props.map((p) => ({ ...p, value: p.value.replace(new RegExp(CREDS.source, "gi"), "$1****@") })) };
}

// ---------- hostnames, URLs, ARNs ----------

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// "https://user:pw@Foo.Example.com.:443/x?y" → "foo.example.com". Route 53 alias targets ("dualstack.x.elb…") too.
export function normalizeHost(raw: string): string | undefined {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^@/]*@/, "");
  s = s.split(/[/?#]/)[0];
  if (s.startsWith("[")) return /^\[([0-9a-f:.]+)\]/.exec(s)?.[1];
  s = s.replace(/:\d{1,5}$/, "").replace(/\.+$/, "").replace(/^dualstack\./, "");
  if (!s || s.length > 253 || !/^[a-z0-9_.-]+$/.test(s)) return undefined;
  return s;
}

export function isPrivateIp(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// A target worth drawing as an external system: a public DNS name or a public IPv4 address.
export const looksLikeHost = (h: string) => (IPV4.test(h) ? !isPrivateIp(h) : HOSTNAME.test(h));

// Every host[:port] named in a configuration value: URLs (with or without credentials), host:port pairs, bare
// hostnames and IPv4 addresses. Normalized and de-duplicated.
export function hostsIn(text: string): { host: string; port?: number }[] {
  const out = new Map<string, { host: string; port?: number }>();
  const push = (h: string | undefined, port?: string) => {
    const host = h ? normalizeHost(h) : undefined;
    if (!host || !/[.:]/.test(host)) return;
    const had = out.get(host);
    if (!had || (had.port === undefined && port)) out.set(host, { host, port: port ? Number(port) : undefined });
  };
  if (!text || text.length > 8192) return [];
  for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/]*@)?(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(?::(\d{2,5}))?/gi)) push(m[1], m[2]);
  for (const m of text.matchAll(/(?:^|[\s,;=@(])([a-z0-9][a-z0-9_.-]*):(\d{2,5})(?=$|[\s,;/)])/gi)) push(m[1], m[2]);
  for (const m of text.matchAll(/(?:^|[^a-z0-9_.-])((?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?=$|[^a-z0-9_-])/gi)) push(m[1]);
  for (const m of text.matchAll(/(?:^|[^\d.])((?:\d{1,3}\.){3}\d{1,3})(?=$|[^\d.])/g)) if (IPV4.test(m[1])) push(m[1]);
  return [...out.values()];
}

const ARN_RE = /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[A-Za-z0-9_+=.@\-/:*$]+/g;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;]+/gi;

// The console's own account: an ARN's account equals it, or neither side has one.
const sameAccount = (acct: string | undefined, accountId: string | undefined) => (acct ? acct === accountId : !accountId);

// An ARN, plus the keys / ARNs of the resource it lives in: a qualified Lambda ARN → the function, a log group's ":*" and
// a secret's JSON key / stage / version → the base ARN, an S3 object → its bucket, a DynamoDB stream or index → its
// table. The console's short keys for ECS, ELB, RDS, ElastiCache and EC2 only for the console's own account (R14):
// region-less in the home region (or when the home region isn't given), "<key>@<region>" elsewhere (CC-6).
export function arnCandidates(arn: string, home?: string, accountId?: string): string[] {
  const base = arnBase(arn.trim());
  const out = [arn, base];
  const p = base.split(":");
  const [, part, svc, region, acct] = p;
  const res = p.slice(5).join(":");
  const prefix = `arn:${part}:${svc}:${region}:${acct}`;
  if (svc === "s3" && res.includes("/")) out.push(`arn:${part}:s3:::${res.split("/")[0]}`);
  if (svc === "dynamodb" && /^table\/[^/]+\//.test(res)) out.push(`${prefix}:table/${res.split("/")[1]}`);
  if (svc === "kinesis" && /^stream\/[^/]+\//.test(res)) out.push(`${prefix}:stream/${res.split("/")[1]}`);
  if (sameAccount(acct, accountId)) {
    const seg = res.split("/");
    if (svc === "ecs" && /^service\/[^/]+\/[^/]+$/.test(res)) out.push(keys.ecsService(seg[1], seg[2], region, home));
    if (svc === "rds" && p[5] === "db" && p[6]) out.push(keys.rds(p[6], region, home));
    if (svc === "rds" && p[5] === "cluster" && p[6]) out.push(`aurora:${p[6]}`); // the alias its member instances carry
    if (svc === "elasticache" && (p[5] === "replicationgroup" || p[5] === "cluster") && p[6]) out.push(keys.elasticache(p[6], region, home));
    if (svc === "ec2" && /^instance\/i-[0-9a-f]+$/.test(res)) out.push(keys.ec2(seg[1], region, home));
    if (svc === "elasticloadbalancing" && /^loadbalancer\/(app|net|gwy)\/[^/]+\//.test(res)) out.push(keys.loadBalancer(seg[2], region, home));
  }
  return [...new Set(out)];
}

// Names a resource of this ARN's type is also known by (its provider lists them as aliases): a KMS alias, an SSM
// parameter's name, a secret's name (a partial ARN has no random suffix), a log group's name, an instance profile's.
function aliasCandidates(p: ParsedArn): string[] {
  const { service, type, id } = p;
  if (service === "kms" && type === "alias") return [`alias/${id}`];
  if (service === "ssm" && type === "parameter") return [`/${id.replace(/^\/+/, "")}`, id];
  if (service === "secretsmanager" && type === "secret") return [id.split(":")[0]];
  if (service === "logs" && type === "log-group") return [id];
  if (service === "iam" && type === "instance-profile") return [id.split("/").pop() ?? id];
  // An Auto Scaling group's ARN carries a UUID nothing else names; alarms and scaling policies name the group
  // ("autoScalingGroup:*:autoScalingGroupName/<name>"), resolved by name in the ARN's region and account.
  if (service === "autoscaling" && type === "autoScalingGroup") {
    const n = /autoScalingGroupName\/(.+)$/.exec(id)?.[1];
    return n ? [n] : [];
  }
  return [];
}

const normUrl = (u: string) => u.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");

// SQS queue URL (current and legacy forms, VPC endpoints included) → queue ARN.
export function sqsArnOf(url: string): string | undefined {
  const m = /^https?:\/\/([^/]+)\/(\d{12})\/([A-Za-z0-9_-]{1,80}(?:\.fifo)?)\/?$/i.exec(url.trim());
  if (!m || !/(?:^|[.-])(?:sqs|queue)[.-]/i.test(m[1]) || !/amazonaws\.com(\.cn)?$/i.test(m[1])) return undefined;
  const region = /([a-z]{2}(?:-gov)?-[a-z]+-\d)/i.exec(m[1])?.[1]?.toLowerCase();
  return region ? `arn:aws:sqs:${region}:${m[2]}:${m[3]}` : undefined;
}

// Bucket named by an S3 endpoint: virtual-hosted (REST, dualstack, website) or path-style URL, or s3://bucket/key.
export function bucketOf(ref: string): string | undefined {
  const t = ref.trim();
  const s3u = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/|$)/i.exec(t);
  if (s3u) return s3u[1].toLowerCase();
  const host = normalizeHost(t);
  if (!host) return undefined;
  const vh = /^(.+?)\.s3(?:-website)?(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.exec(host);
  if (vh && vh[1] !== "s3") return vh[1];
  if (/^s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.test(host) && /:\/\//.test(t)) {
    const path = t.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?/i, "").split(/[/?#]/)[0];
    if (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(path)) return path;
  }
  return undefined;
}

// ElastiCache node / primary / reader endpoints differ only in their first label. Serverless caches all end in
// "serverless.<region>.cache.amazonaws.com" after their own first label, so they only ever match whole.
const cacheTail = (h: string) => {
  if (!h.endsWith(".cache.amazonaws.com") || h.split(".").length < 5) return undefined;
  const tail = h.replace(/^[^.]+\./, "");
  return tail.startsWith("serverless.") ? undefined : tail;
};
// Aurora cluster writer / reader endpoints → the cluster id (its instances carry the alias "aurora:<id>").
const auroraOf = (h: string) => /^([a-z0-9-]+)\.cluster-(?:ro-|custom-)?[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com(?:\.cn)?$/.exec(h)?.[1];

// ---------- the index ----------

// Words that name too many things to count as a mention on their own ("api", "orders", "prod"…).
const COMMON = new Set(
  (
    "api app apps web www site main default service services server worker workers job jobs queue queues topic topics event events order orders " +
    "user users data db database cache redis valkey memcached postgres postgresql mysql mongo logs log admin public private internal external " +
    "local localhost true false null none yes no info debug warn warning error http https tcp udp json yaml xml text html email mail sms push " +
    "notification notifications config settings auth login session sessions token tokens asset assets static media upload uploads image images " +
    "file files backup backups archive tmp temp cron scheduler primary replica reader writer master stream streams table tables bucket buckets " +
    "function functions lambda frontend backend client clients shop store cart carts payments billing search index report reports metrics"
  ).split(" "),
);

export function tokenEligible(s: string): boolean {
  const t = s.toLowerCase();
  return t.length >= 3 && t.length <= 255 && /^[a-z0-9._-]+$/.test(t) && !/^[\d._-]+$/.test(t) && !COMMON.has(t) && !stageIdOf(t);
}

// Generic rows (the catch-all) and references resolve by ARN and exact name, never as a token inside a longer value.
const NO_TOKENS = new Set<ResourceKind>(["external", "route53-zone", "cloudflare-zone", "aws-resource"]);

interface Index {
  byKey: Map<string, Resource>;
  byArn: Map<string, string[]>;
  byHost: Map<string, string[]>;
  byUrl: Map<string, string[]>;
  byAlias: Map<string, string[]>; // exact names / aliases, lower-cased (whole-reference resolution of Links)
  byToken: Map<string, string[]>; // names eligible as a whole token inside a longer value
  byBucket: Map<string, string[]>;
  byCacheTail: Map<string, string[]>;
  dns: Map<string, { key: string; routing?: Routing }[]>; // names learned from DNS records → every target they route to (R15)
  ambiguous: Map<string, string[]>; // hostnames a reference named that several resources claim (none of them linked)
  home?: string;
  account?: string;
  regions: Set<string>; // regions the inventory covers: an ARN outside them is a reference, not a stale one
}

const put = (m: Map<string, string[]>, k: string | undefined, v: string) => {
  if (!k) return;
  const l = m.get(k);
  if (!l) m.set(k, [v]);
  else if (!l.includes(v)) l.push(v);
};

function indexHost(ix: Index, raw: string, key: string) {
  const h = normalizeHost(raw);
  if (!h) return;
  put(ix.byHost, h, key);
  put(ix.byCacheTail, cacheTail(h), key);
}

function indexResource(ix: Index, r: Resource) {
  ix.byKey.set(r.key, r);
  if (r.key.startsWith("arn:")) put(ix.byArn, r.key, r.key);
  const names = [r.name, ...(r.aliases ?? [])].filter(Boolean);
  for (const a of names) {
    if (a.startsWith("arn:")) put(ix.byArn, a, r.key);
    else if (a.includes("://")) {
      put(ix.byUrl, normUrl(a), r.key);
      const arn = sqsArnOf(a);
      if (arn) put(ix.byArn, arn, r.key);
    } else {
      put(ix.byAlias, a.toLowerCase(), r.key);
      if (!NO_TOKENS.has(r.kind) && tokenEligible(a)) put(ix.byToken, a.toLowerCase(), r.key);
    }
  }
  if (r.kind === "s3") for (const a of names) if (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(a)) put(ix.byBucket, a, r.key);
  for (const e of r.endpoints ?? []) {
    if (e.includes("://")) put(ix.byUrl, normUrl(e), r.key);
    indexHost(ix, e, r.key);
  }
}

function buildIndex(resources: Resource[], scope: Pick<Index, "home" | "account" | "regions">): Index {
  const ix: Index = {
    byKey: new Map(), byArn: new Map(), byHost: new Map(), byUrl: new Map(), byAlias: new Map(), byToken: new Map(), byBucket: new Map(),
    byCacheTail: new Map(), dns: new Map(), ambiguous: new Map(), ...scope,
  };
  for (const r of resources) indexResource(ix, r);
  return ix;
}

const one = (l?: string[]) => (l?.length === 1 ? l[0] : undefined);

// Resources a hostname points at. `multi`: every match counts — an Aurora cluster endpoint names all its instances, and
// a name with several DNS records (weighted, failover, latency…) routes to all its targets (`dns` says how); otherwise
// only an unambiguous match does.
function hostKeys(ix: Index, h: string): { keys: string[]; multi: boolean; dns?: { key: string; routing?: Routing }[] } {
  const direct = ix.byHost.get(h);
  if (direct?.length) {
    const learned = ix.dns.get(h);
    if (direct.length > 1 && learned && direct.every((k) => learned.some((x) => x.key === k))) return { keys: direct, multi: true, dns: learned };
    return { keys: direct, multi: false };
  }
  const b = bucketOf(h);
  if (b && ix.byBucket.get(b)?.length) return { keys: ix.byBucket.get(b)!, multi: false };
  const tail = cacheTail(h);
  if (tail && ix.byCacheTail.get(tail)?.length) return { keys: ix.byCacheTail.get(tail)!, multi: false };
  const au = auroraOf(h);
  if (au && ix.byAlias.get(`aurora:${au}`)?.length) return { keys: ix.byAlias.get(`aurora:${au}`)!, multi: true };
  return { keys: [], multi: false };
}

// Two resources answer to one name and no DNS record says which: a reference to it links neither (R15), and both are
// told so (facts.ambiguousHost, plus one note per name).
const ambiguous = (ix: Index, host: string, list: string[]) => ix.ambiguous.set(host, [...new Set([...(ix.ambiguous.get(host) ?? []), ...list])]);

// A hit by name or short key must live in the ARN's region (global resources live everywhere) and account.
const scoped = (r: Resource | undefined, p: ParsedArn | undefined) =>
  !!r && (!p?.region || !r.region || r.region === "global" || r.region === p.region) && (!p?.account || !r.account || r.account === p.account);

function arnKeys(ix: Index, arn: string): string[] {
  const p = parseArn(arnBase(arn.trim()));
  for (const c of arnCandidates(arn, ix.home, ix.account)) {
    if (c.startsWith("aurora:")) {
      const l = (ix.byAlias.get(c) ?? []).filter((k) => scoped(ix.byKey.get(k), p));
      if (l.length) return l;
      continue;
    }
    if (ix.byKey.has(c)) {
      if (c.startsWith("arn:") || scoped(ix.byKey.get(c), p)) return [c];
      continue;
    }
    const k = ix.byArn.get(c);
    if (k?.length === 1) return k;
  }
  if (p && sameAccount(p.account, ix.account))
    for (const a of aliasCandidates(p)) {
      const l = (ix.byAlias.get(a.toLowerCase()) ?? []).filter((k) => scoped(ix.byKey.get(k), p));
      if (l.length === 1) return l;
    }
  return [];
}

// An ARN of another account, or of a region the inventory doesn't read: it can't resolve here, so it is drawn as a
// reference node rather than dropped (R14). AWS-owned ARNs (managed policies) and patterns never are.
function foreignArn(ix: Index, arn: string): ParsedArn | undefined {
  if (arn.includes("*")) return undefined;
  const p = parseArn(arnBase(arn.trim()));
  if (!p || p.account === "aws") return undefined;
  const otherAccount = !!p.account && !!ix.account && p.account !== ix.account;
  const otherRegion = !!p.region && !!ix.home && p.region !== ix.home && !ix.regions.has(p.region);
  return otherAccount || otherRegion ? p : undefined;
}

// A Link end: a key, or one reference (ARN, URL, hostname, IP, name). `host` = unresolved but looks like a hostname;
// `foreign` = an ARN of another account or region (see foreignArn).
function resolveRef(ix: Index, ref: string): { keys: string[]; host?: string; foreign?: string } {
  const t = String(ref ?? "").trim();
  if (!t) return { keys: [] };
  if (ix.byKey.has(t)) return { keys: [t] };
  if (t.startsWith("arn:")) {
    const k = arnKeys(ix, t);
    return k.length ? { keys: k } : { keys: [], foreign: foreignArn(ix, t) ? arnBase(t) : undefined };
  }
  if (t.includes("://")) {
    const u = one(ix.byUrl.get(normUrl(t)));
    if (u) return { keys: [u] };
    const q = sqsArnOf(t);
    if (q && ix.byArn.get(q)?.length === 1) return { keys: ix.byArn.get(q)! };
    const b = bucketOf(t);
    if (b && ix.byBucket.get(b)?.length === 1) return { keys: ix.byBucket.get(b)! };
  }
  const h = normalizeHost(t);
  if (h) {
    const hk = hostKeys(ix, h);
    if (hk.multi && hk.keys.length) return { keys: hk.keys };
    if (hk.keys.length === 1) return { keys: hk.keys };
    if (hk.keys.length > 1) ambiguous(ix, h, hk.keys);
    if (!hk.keys.length && looksLikeHost(h) && !ix.byAlias.has(t.toLowerCase())) return { keys: [], host: h };
  }
  const a = one(ix.byAlias.get(t.toLowerCase()));
  return { keys: a ? [a] : [] };
}

// ---------- mentions ----------

const varName = (via: string) => /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(via)?.[1]?.toUpperCase() ?? "";
const SQL_KINDS = new Set<ResourceKind>(["rds", "rds-cluster", "docdb-cluster", "neptune-cluster", "rds-proxy", "redshift-cluster", "redshift-workgroup", "lightsail-database"]);
const CACHE_KINDS = new Set<ResourceKind>(["elasticache", "elasticache-serverless", "memorydb-cluster"]);
// The variable's name picks between resources that share a name ("…_TABLE" → a DynamoDB table). First match wins, so
// the specific words come before the broad ones (DB_SECRET_ARN is a secret, not a database).
const HINTS: [RegExp, ResourceKind[]][] = [
  [/SECRET/, ["secret"]], [/PARAM|SSM/, ["ssm-parameter"]], [/KMS|KEY_(?:ID|ARN)/, ["kms-key"]], [/LOG_?GROUP/, ["log-group"]], [/ROLE/, ["iam-role"]],
  [/QUEUE|SQS/, ["sqs"]], [/TOPIC|SNS/, ["sns"]], [/TABLE|DYNAMO/, ["dynamodb"]], [/BUCKET|S3/, ["s3"]], [/FIREHOSE|DELIVERY_?STREAM/, ["firehose-stream"]],
  [/STREAM|KINESIS/, ["kinesis"]], [/FUNCTION|LAMBDA/, ["lambda"]], [/STATE_?MACHINE|SFN|WORKFLOW/, ["stepfunctions"]], [/EVENT_?BUS/, ["eventbridge-bus"]],
  [/KAFKA|MSK/, ["msk-cluster"]], [/RABBIT|AMQP|MQ_|_MQ/, ["mq-broker"]], [/OPENSEARCH|ELASTICSEARCH/, ["opensearch-domain"]],
  [/REPO|ECR|IMAGE/, ["ecr-repository"]], [/EFS|FILE_?SYSTEM/, ["efs-filesystem"]],
  [/DATABASE|DB_|_DB|PG|POSTGRES|MYSQL/, [...SQL_KINDS]], [/REDIS|VALKEY|CACHE|MEMCACHE/, [...CACHE_KINDS]],
];
const HTTPISH = new Set<ResourceKind>([
  "loadbalancer", "classic-elb", "apigateway", "appsync-api", "cloudfront", "global-accelerator", "lattice-service", "apprunner", "beanstalk", "amplify-app",
  "lightsail-instance", "lightsail-container", "ecs-service", "ec2-instance", "eks-workload", "opensearch-domain", "external",
]);

export function mentionKind(target: ResourceKind, via: string): EdgeKind {
  const v = varName(via);
  if (SQL_KINDS.has(target)) return "sql";
  if (CACHE_KINDS.has(target)) return "cache";
  if (target === "sqs") return /QUEUE|SQS/.test(v) ? "writes" : "uses";
  if (target === "sns") return /TOPIC|SNS/.test(v) ? "writes" : "uses";
  if (target === "eventbridge-bus") return /BUS/.test(v) ? "writes" : "uses";
  if (target === "firehose-stream") return "writes";
  if (target === "msk-cluster" || target === "mq-broker") return "stream";
  if (target === "secret" || target === "ssm-parameter") return "reads";
  if (target === "iam-role") return "assumes";
  if (target === "log-group") return "logs";
  if (target === "ecr-repository") return "pulls";
  if (target === "efs-filesystem" || target === "fsx-filesystem") return "mounts";
  if (HTTPISH.has(target)) return "http";
  return "uses";
}

// What a generic row or a reference is, for the edge kind of a mention ("rds:db" → sql). Resource Explorer spelling.
const TYPE_KIND: Record<string, ResourceKind> = {
  "rds:db": "rds", "rds:cluster": "rds-cluster", "rds:db-proxy": "rds-proxy", "elasticache:replicationgroup": "elasticache", "elasticache:cluster": "elasticache",
  "elasticache:serverlesscache": "elasticache-serverless", "memorydb:cluster": "memorydb-cluster", "redshift:cluster": "redshift-cluster", "es:domain": "opensearch-domain",
  "sqs:queue": "sqs", "sns:topic": "sns", "events:event-bus": "eventbridge-bus", "kafka:cluster": "msk-cluster", "mq:broker": "mq-broker",
  "firehose:deliverystream": "firehose-stream", "kinesis:stream": "kinesis", "lambda:function": "lambda", "states:stateMachine": "stepfunctions",
  "secretsmanager:secret": "secret", "ssm:parameter": "ssm-parameter", "kms:key": "kms-key", "kms:alias": "kms-key", "logs:log-group": "log-group",
  "iam:role": "iam-role", "s3:bucket": "s3", "dynamodb:table": "dynamodb", "ecr:repository": "ecr-repository", "elasticfilesystem:file-system": "efs-filesystem",
};
const kindOf = (r: Resource): ResourceKind => (r.kind === "aws-resource" && r.resourceType && Object.hasOwn(TYPE_KIND, r.resourceType) ? TYPE_KIND[r.resourceType] : r.kind);

const engineOf = (r: Resource) => r.props.find((p) => p.label === "Engine")?.value.split(/\s+/)[0]?.toLowerCase().replace(/^aurora-/, "");

// How DNS splits traffic over a name's targets, as an edge label: "weighted 50", "failover primary", "latency".
export function routingLabel(r?: Routing): string | undefined {
  if (!r || r.policy === "simple") return undefined;
  if (r.policy === "weighted") return r.weight === undefined ? "weighted" : `weighted ${r.weight}`;
  if (r.policy === "failover") return r.role ? `failover ${r.role}` : "failover";
  return r.policy === "ip" ? "IP-based" : r.policy;
}

interface MentionHit {
  key: string;
  port?: number;
  routing?: Routing; // reached through a DNS name with several records (R15)
}

// Every resource one configuration value names: ARNs, URLs (queue URLs, S3), hostnames and IPs, and — as whole
// tokens — distinctive names (bucket, table, queue, function names). Ambiguous names are resolved with the
// variable's name ("…_TABLE" → a DynamoDB table) or dropped. `foreign` turns an ARN of another account or region into
// the key of its reference node (or undefined).
function mentionHits(ix: Index, ref: string, via: string, foreign: (arn: string) => string | undefined): MentionHit[] {
  const out = new Map<string, MentionHit>();
  const add = (k: string, port?: number, routing?: Routing) => {
    const had = out.get(k);
    if (!had || (had.port === undefined && port)) out.set(k, { key: k, port, routing: routing ?? had?.routing });
  };
  if (!ref || typeof ref !== "string" || ref.length > 8192) return [];
  if (ix.byKey.has(ref.trim())) add(ref.trim());
  for (const m of ref.matchAll(ARN_RE)) {
    const ks = arnKeys(ix, m[0]);
    if (ks.length) for (const k of ks) add(k);
    else {
      const f = foreign(m[0]);
      if (f) add(f);
    }
  }
  for (const m of ref.matchAll(URL_RE)) {
    const u = one(ix.byUrl.get(normUrl(m[0])));
    if (u) add(u);
    const q = one(ix.byArn.get(sqsArnOf(m[0].replace(/[).\]]+$/, "")) ?? ""));
    if (q) add(q);
    const b = bucketOf(m[0]);
    if (b && ix.byBucket.get(b)?.length === 1) add(ix.byBucket.get(b)![0]);
  }
  for (const { host, port } of hostsIn(ref)) {
    const hk = hostKeys(ix, host);
    if (hk.multi || hk.keys.length === 1) for (const k of hk.keys) add(k, port, hk.dns?.find((x) => x.key === k)?.routing);
    else if (hk.keys.length > 1) ambiguous(ix, host, hk.keys);
  }
  const hint = HINTS.find(([re]) => re.test(varName(via)))?.[1];
  for (const tok of ref.split(/[^A-Za-z0-9._-]+/)) {
    const t = tok.replace(/^[._-]+|[._-]+$/g, "").toLowerCase();
    if (!t || !tokenEligible(t)) continue;
    let ks = ix.byToken.get(t);
    if (!ks?.length) continue;
    if (ks.length > 1 && hint) ks = ks.filter((k) => hint.includes(ix.byKey.get(k)!.kind));
    if (ks.length === 1) add(ks[0]);
  }
  return [...out.values()];
}

// ---------- edges ----------

const RANK: Record<Edge["confidence"], number> = { config: 3, allowed: 2, mentioned: 1 };
const MAX_EVIDENCE = 8;
// Most security-group-only edges drawn into one target (F14, as in src/lib/discover.ts); the rest are noted.
const MAX_ALLOWED_PER_TARGET = 50;
const DECLARED = /console\.config\.json/;

class Edges {
  private m = new Map<string, Edge>();
  private pairs = new Map<string, Edge[]>(); // "from\0to" → edges of any kind, for between()
  private declared = new Set<string>(); // edge ids whose label was declared in console.config.json
  add(e: Omit<Edge, "id">): Edge | undefined {
    if (!e.from || !e.to || e.from === e.to) return undefined;
    const id = `${e.from}->${e.to}:${e.kind}`;
    const had = this.m.get(id);
    if (!had) {
      const edge: Edge = { id, ...e, evidence: [...new Set(e.evidence.filter(Boolean))].slice(0, MAX_EVIDENCE) };
      if (!edge.label) delete edge.label;
      if (!edge.routing) delete edge.routing;
      if (edge.label && e.evidence.some((x) => DECLARED.test(x))) this.declared.add(id);
      this.m.set(id, edge);
      const pair = `${e.from}\0${e.to}`;
      this.pairs.set(pair, [...(this.pairs.get(pair) ?? []), edge]);
      return edge;
    }
    had.evidence = [...new Set([...had.evidence, ...e.evidence.filter(Boolean)])].slice(0, MAX_EVIDENCE);
    if (e.label && e.label !== had.label) this.label(had, e);
    if (RANK[e.confidence] > RANK[had.confidence]) had.confidence = e.confidence;
    if (!had.routing && e.routing) had.routing = e.routing;
    return had;
  }
  // F72: a label AWS reports (a listener rule's hosts and paths) and one declared in console.config.json say different
  // things — keep both, AWS first ("api.example.com · api.* → :3000"). Otherwise the first label stays.
  private label(had: Edge, e: Omit<Edge, "id">) {
    const declared = e.evidence.some((x) => DECLARED.test(x));
    if (!had.label) {
      had.label = e.label;
      if (declared) this.declared.add(had.id);
      return;
    }
    if (e.confidence !== "config" || had.label.split(" · ").includes(e.label!)) return;
    if (this.declared.has(had.id) && !declared) {
      had.label = `${e.label} · ${had.label}`;
      this.declared.delete(had.id);
    } else if (!this.declared.has(had.id) && declared && had.confidence === "config") had.label = `${had.label} · ${e.label}`;
  }
  between(from: string, to: string): Edge | undefined {
    let best: Edge | undefined;
    for (const e of this.pairs.get(`${from}\0${to}`) ?? []) if (!best || RANK[e.confidence] > RANK[best.confidence]) best = e;
    return best;
  }
  list() {
    return [...this.m.values()];
  }
}

const isZone = (r?: Resource) => r?.kind === "route53-zone" || r?.kind === "cloudflare-zone";

function externalFor(host: string, provider: string): Resource {
  return {
    key: keys.external(host), kind: "external", provider, name: host, region: "global", tags: {}, health: "unknown",
    healthReason: "Nothing in this account answers to this name — an outside system, or something the console can't list.",
    props: [{ label: "Hostname", value: host, mono: true }], endpoints: [host],
  };
}

// A resource of another account or region that configuration names (R14): shown, never guessed onto a local one.
function referenceFor(arn: string, p: ParsedArn, provider: string): Resource {
  const type = arnType(p);
  const info = infoOf(type);
  const where = `${p.account || "?"}/${p.region || "global"}`;
  return {
    key: arn, kind: "aws-resource", provider, name: arnName(p), region: p.region || "global", tags: {}, health: "unknown",
    healthReason: `referenced in configuration — not in this account/region (${where})`,
    props: [
      { label: "Service", value: info.service.label }, { label: "Type", value: info.label }, { label: "ARN", value: arn, mono: true },
      { label: "Account", value: p.account || "—", mono: true }, { label: "Region", value: p.region || "global" },
    ],
    service: info.service.label, resourceType: type, category: info.category, source: "reference", account: p.account || undefined, facts: { remote: true },
  };
}

export interface InferInput {
  results: ProviderResult[]; // in provider order; for the same key, later reports win
  rules?: Record<string, SgRule[]>; // security group id → inbound rules, for "allowed" edges (ProviderResult.sgRules win)
  providerOf?: (i: number) => string; // provider id of results[i] (external and reference nodes are credited to it)
  home?: string; // the home region: region-less console keys (rds:, elb:, ecs:service/…) live there (CC-6)
  covered?: Set<string>; // "<Resource Explorer type>@<region>" that first-class providers listed completely (B.4)
  accountId?: string; // the console's account (else the one its resources' ARNs name): other accounts never resolve to short keys
  regions?: string[]; // the console's regions (else the regions its resources live in): ARNs outside them are references
  unreadable?: Record<string, string>; // "<type>@<region>" → "<provider> couldn't read it (<action>)", for generic rows of that type
}

export interface Inferred {
  resources: Resource[];
  edges: Edge[];
  notes: string[]; // what the map leaves out or can't decide ("security groups allow 120 sources into …: showing 50")
  hiddenTypes: Record<string, number>; // generic rows dropped as sub-objects, by type ("ec2:network-interface": 14)
}

// The account most of the resources' ARNs name — the console's own, when the inventory didn't say.
function accountOf(resources: Resource[]): string | undefined {
  const n = new Map<string, number>();
  for (const r of resources)
    for (const a of [r.key, ...(r.aliases ?? [])]) {
      const acct = a.startsWith("arn:") ? parseArn(a)?.account : undefined;
      if (acct && /^\d{12}$/.test(acct)) n.set(acct, (n.get(acct) ?? 0) + 1);
    }
  return [...n].sort((x, y) => y[1] - x[1])[0]?.[0];
}

const SOURCE: Record<string, string> = { "resource-explorer": "Resource Explorer", tagging: "the Tagging API", config: "AWS Config", cloudcontrol: "Cloud Control" };

function coveredBy(covered: Set<string> | undefined, type: string, region: string): boolean {
  if (!covered?.size) return false;
  if (region !== "global") return covered.has(`${type}@${region}`);
  for (const c of covered) if (c.startsWith(`${type}@`)) return true;
  return false;
}

// The catch-all's rows against the first-class resources (B.4): a sub-object is only counted; a row that is a
// resource some provider already shows is dropped and gives it the tags it lacks (a field-level copy — never
// mergeResource, so it can't relabel the resource); a Systems Manager managed instance is folded into its EC2
// instance the same way. A row of a type a provider listed completely but that matched nothing is stale when other
// rows of that type and region did match (the key format works; Resource Explorer still indexes something deleted):
// it is left out with a note. If nothing of that type matched, it is kept hidden and flagged (a key-format bug fails
// visibly). The rest are generic resources.
function foldGenerics(ix: Index, generics: Resource[], input: InferInput, notes: string[]): { kept: Resource[]; hiddenTypes: Record<string, number> } {
  const hiddenTypes: Record<string, number> = {};
  const kept: Resource[] = [];
  const matched = new Set<string>(); // type@region with at least one row that matched a first-class resource
  const unmatched = new Map<string, Resource[]>(); // covered type@region → its rows that matched nothing
  let owners: Map<string, string> | undefined;
  const ownerOf = (type: string) => {
    owners ??= new Map([...ix.byKey.values()].flatMap((r) => [r.key, ...(r.aliases ?? [])].map((a) => parseArn(a)).filter((p): p is ParsedArn => !!p).map((p) => [arnType(p), r.provider] as [string, string])));
    return owners.get(type);
  };
  for (const g of generics) {
    const p = parseArn(g.key);
    const type = g.resourceType || (p ? arnType(p) : "");
    if (!type) continue;
    const region = g.region && g.region !== "global" ? g.region : p?.region || "global";
    const info = infoOf(type);
    if (info.visibility === "drop") {
      hiddenTypes[type] = (hiddenTypes[type] ?? 0) + 1;
      continue;
    }
    const at = `${type}@${region}`;
    const hit = g.key.startsWith("arn:") ? arnKeys(ix, g.key) : ix.byKey.has(g.key) ? [g.key] : [];
    if (hit.length) {
      matched.add(at);
      const r = hit.length === 1 ? ix.byKey.get(hit[0]) : undefined;
      if (r) for (const [k, v] of Object.entries(g.tags ?? {})) if (!Object.hasOwn(r.tags, k)) r.tags[k] = v;
      continue;
    }
    // Systems Manager's record of an instance is that instance, not a second resource. Its ARN becomes one of the
    // instance's aliases (after the instance's own), so a reference to it, and a count by ARN type, finds the instance.
    if (type === "ssm:managed-instance" && p?.id) {
      const inst = ix.byKey.get(`ec2:${p.id}`) ?? ix.byKey.get(`ec2:${p.id}@${region}`);
      if (inst?.kind === "ec2-instance") {
        for (const [k, v] of Object.entries(g.tags ?? {})) if (!Object.hasOwn(inst.tags, k)) inst.tags[k] = v;
        if (!inst.props.some((x) => x.label === "Systems Manager")) inst.props.push({ label: "Systems Manager", value: "managed instance" });
        if (!inst.aliases?.includes(g.key)) inst.aliases = [...(inst.aliases ?? []), g.key];
        continue;
      }
    }
    const parent = g.parent?.startsWith("arn:") ? one(arnKeys(ix, g.parent)) ?? g.parent : g.parent;
    const base: Resource = { ...g, parent, resourceType: type, service: g.service ?? info.service.label, category: g.category ?? info.category };
    if (coveredBy(input.covered, type, region)) {
      unmatched.set(at, [...(unmatched.get(at) ?? []), base]);
      continue;
    }
    const why = Object.hasOwn(input.unreadable ?? {}, `${type}@${region}`) ? input.unreadable![`${type}@${region}`] : undefined;
    kept.push({
      ...base, hidden: info.visibility === "table" ? true : undefined,
      healthReason: why ? `Listed by ${SOURCE[g.source ?? ""] ?? "the catch-all"} — ${why}` : g.healthReason ?? "No dedicated reader for this type yet",
    });
  }
  for (const [at, rows] of unmatched) {
    const [type, region] = at.split("@");
    const owner = ownerOf(type) ?? "its provider";
    if (matched.has(at)) {
      notes.push(`catch-all: ${rows.length} ${type} in ${region} listed by ${SOURCE[rows[0].source ?? ""] ?? "the catch-all"} but not by ${owner}, which returned the others of that type — stale index entries, left out`);
      continue;
    }
    for (const r of rows) kept.push({ ...r, hidden: true, healthReason: `Covered by ${owner} but not matched — key-format bug?` });
    notes.push(`catch-all: ${rows.length} ${type} in ${region} covered by ${owner} but not matched — key-format bug?`);
  }
  return { kept, hiddenTypes };
}

// Inbound rules by group: the security-group provider's (ProviderResult.sgRules) win over the inventory's own read.
// Keyed by group id, without a prototype: a group id is provider data and must never reach Object.prototype.
function sgRulesOf(input: InferInput): Record<string, SgRule[]> {
  const out: Record<string, SgRule[]> = Object.create(null);
  for (const [id, list] of Object.entries(input.rules ?? {})) if (Array.isArray(list)) out[id] = list;
  for (const g of input.results.flatMap((r) => (Array.isArray(r.sgRules) ? r.sgRules : [])) as SecurityGroupFacts[])
    if (typeof g?.groupId === "string" && g.groupId && Array.isArray(g.inbound))
      out[g.groupId] = g.inbound
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ fromPort: x.fromPort, toPort: x.toPort, groups: Array.isArray(x.groups) ? [...x.groups] : [], cidrs: x.cidrs, prefixLists: x.prefixLists }));
  return out;
}

const DATABASES = new Set<ResourceKind>([...SQL_KINDS, "opensearch-domain"]);
// File systems are mounted, never connect out: as a source of an "allowed" edge they would only be a guess.
const TARGET_ONLY = new Set<ResourceKind>(["efs-filesystem", "fsx-filesystem"]);
// What a database or cache listens on, for port-aware "allowed" edges (ruleReaches in src/lib/discover.ts): its Port
// prop, else its endpoint's port; OpenSearch serves HTTPS. Empty = unknown, and any rule counts.
export function listenPorts(r: Pick<Resource, "kind" | "props">): number[] {
  const out = new Set<number>();
  for (const p of r.props ?? []) {
    const v = String(p.value ?? "").trim();
    if (p.label === "Port" && /^\d{1,5}$/.test(v)) out.add(Number(v));
    else if (p.label === "Endpoint") {
      const m = /:(\d{1,5})$/.exec(v);
      if (m) out.add(Number(m[1]));
    }
  }
  if (!out.size && r.kind === "opensearch-domain") out.add(443);
  return [...out].filter((n) => n > 0 && n < 65536);
}
const regional = (r: Resource) => !!r.region && r.region !== "global";
// Security groups only connect resources of one VPC, in one region.
const sameNetwork = (a: Resource, b: Resource) => !(a.vpcId && b.vpcId && a.vpcId !== b.vpcId) && !(regional(a) && regional(b) && a.region !== b.region);

export function infer(input: InferInput): Inferred {
  const notes: string[] = [];
  const all = input.results.flatMap((r) => r.resources ?? []);
  const generic = (r: Resource) => r?.kind === "aws-resource";
  const resources = mergeResources(all.filter((r) => !generic(r)));
  const regions = new Set(input.regions?.length ? input.regions : resources.filter(regional).map((r) => r.region));
  if (input.home) regions.add(input.home);
  const ix = buildIndex(resources, { home: input.home, account: input.accountId ?? accountOf(resources), regions });
  const { kept, hiddenTypes } = foldGenerics(ix, mergeResources(all.filter(generic)), input, notes);
  for (const g of kept) {
    resources.push(g);
    indexResource(ix, g);
  }
  const edges = new Edges();
  const externals = new Map<string, Resource>();

  const resolveTo = (ref: string) => resolveRef(ix, ref);
  const addExternal = (host: string, provider: string) => {
    const key = keys.external(host);
    if (!ix.byKey.has(key)) {
      const x = externalFor(host, provider);
      externals.set(key, x);
      ix.byKey.set(key, x);
      put(ix.byHost, host, key);
    }
    return key;
  };
  const addReference = (arn: string, provider: string): string | undefined => {
    const key = arnBase(arn.trim());
    if (ix.byKey.has(key)) return key;
    const p = foreignArn(ix, key);
    if (!p) return undefined;
    const x = referenceFor(key, p, provider);
    externals.set(key, x);
    ix.byKey.set(key, x);
    put(ix.byArn, key, key);
    return key;
  };
  // A DNS record resolved to a resource: that name now points at it too (CNAME chains, origins named by DNS). A name
  // with several records (weighted, failover, latency…) points at every target (R15); a name a resource answers to
  // itself is never re-pointed.
  const learnName = (label: string | undefined, key: string, routing?: Routing) => {
    const name = label ? hostsIn(label)[0]?.host : undefined;
    const r = ix.byKey.get(key);
    if (!name || !r || r.kind === "external") return;
    const learned = ix.dns.get(name);
    if ((ix.byHost.get(name)?.length && !learned) || learned?.some((x) => x.key === key)) return;
    ix.dns.set(name, [...(learned ?? []), { key, routing }]);
    put(ix.byHost, name, key);
    r.endpoints = union(r.endpoints, [name]);
  };

  type L = Link & { provider: string };
  const links: L[] = input.results.flatMap((r, i) => (r.links ?? []).map((l) => ({ ...l, provider: input.providerOf?.(i) ?? "inventory" })));
  const place = (l: L, final: boolean): boolean => {
    const from = resolveTo(l.from).keys;
    const to = resolveTo(l.to);
    if (!from.length) return final; // unknown source: nothing to draw from
    let targets = to.keys;
    if (!targets.length) {
      if (!final) return false;
      const ref = to.foreign ? addReference(to.foreign, l.provider) : undefined;
      if (ref) targets = [ref];
      else if (to.host) targets = [addExternal(to.host, l.provider)];
      else return true;
    }
    for (const f of from) for (const t of targets) {
      edges.add({ from: f, to: t, kind: l.kind, label: l.label, evidence: [l.evidence], confidence: l.confidence ?? "config", routing: l.routing });
      if (isZone(ix.byKey.get(f)) && l.kind === "route") learnName(l.label, t, l.routing);
    }
    return true;
  };
  // DNS first, a few rounds, so a record that points at another record in the account still lands on a resource.
  let pending = links.filter((l) => isZone(ix.byKey.get(resolveTo(l.from).keys[0] ?? "")));
  const rest = links.filter((l) => !pending.includes(l));
  for (let round = 0; round < 4 && pending.length; round++) {
    const next = pending.filter((l) => !place(l, false));
    if (next.length === pending.length) break;
    pending = next;
  }
  for (const l of [...pending, ...rest]) place(l, true);

  input.results.forEach((res, i) => {
    const provider = input.providerOf?.(i) ?? "inventory";
    for (const m of (res.mentions ?? []) as Mention[]) {
      if (!ix.byKey.has(m.from)) continue;
      for (const ref of m.refs ?? []) {
        for (const hit of mentionHits(ix, ref, m.via, (arn) => addReference(arn, provider))) {
          if (hit.key === m.from) continue;
          const target = ix.byKey.get(hit.key)!;
          const kind = mentionKind(kindOf(target), m.via);
          const engine = kind === "sql" || kind === "cache" ? engineOf(target) ?? (target.kind === "aws-resource" ? target.resourceType?.split(":")[0] : target.kind) : undefined;
          const label = engine ? `${engine}${hit.port ? `:${hit.port}` : ""}` : routingLabel(hit.routing);
          edges.add({ from: m.from, to: hit.key, kind, label, evidence: [m.via], confidence: "mentioned", routing: hit.routing });
        }
      }
    }
  });

  // Security groups: the target allows traffic from one of the source's groups (same VPC). The shared rules of
  // src/lib/discover.ts, so the ECS views and the map agree: no service ↔ service mesh from a self-referencing group
  // (its members get facts.peerGroups instead), service → database / cache kept, at most 50 guesses into one target.
  // When the two are already connected (a route, a connection string), the rule only adds its evidence to that edge.
  const rules = sgRulesOf(input);
  if (Object.keys(rules).length) {
    const nodes: NodeRef[] = [];
    for (const r of resources) {
      if (!r.securityGroups?.length || r.kind === "external" || r.kind === "aws-resource" || isSupport(categoryOf(r))) continue;
      const kind = DATABASES.has(r.kind) ? "database" : CACHE_KINDS.has(r.kind) ? "cache" : "service";
      nodes.push({ id: r.key, kind, securityGroups: r.securityGroups, ports: kind === "service" ? [] : listenPorts(r), engine: engineOf(r) });
    }
    const c = inferConnections(nodes, rules, {}, { maxAllowedPerTarget: Number.POSITIVE_INFINITY });
    const peerOf = new Map<string, string[]>();
    for (const g of c.peerGroups) {
      const fact = `${g.group} (self-referencing, ${g.members.length} member${g.members.length === 1 ? "" : "s"})`;
      for (const k of g.members) {
        peerOf.set(k, [...(peerOf.get(k) ?? []), g.group]);
        const r = ix.byKey.get(k)!;
        const had = Array.isArray(r.facts?.peerGroups) ? (r.facts.peerGroups as string[]) : [];
        r.facts = { ...(r.facts ?? {}), peerGroups: [...new Set([...had, fact])] };
      }
    }
    // Two members of one self-referencing group connected some other way: the group's rule is evidence too.
    for (const e of edges.list()) {
      const shared = peerOf.get(e.from)?.find((g) => peerOf.get(e.to)?.includes(g));
      const a = ix.byKey.get(e.from), b = ix.byKey.get(e.to);
      if (shared && a && b && sameNetwork(a, b)) edges.add({ from: e.from, to: e.to, kind: e.kind, evidence: [`security group ${shared} allows ${shared}`], confidence: "allowed" });
    }
    const fresh = new Map<string, typeof c.edges>();
    for (const e of c.edges) {
      const a = ix.byKey.get(e.from), b = ix.byKey.get(e.to);
      if (!a || !b || !sameNetwork(a, b)) continue;
      if (b.kind === "lambda") continue; // a function in a VPC takes no inbound connections: its SG rules mean nothing as a target
      if (TARGET_ONLY.has(a.kind)) continue;
      const known = edges.between(e.from, e.to);
      if (known) edges.add({ from: known.from, to: known.to, kind: known.kind, evidence: [e.source], confidence: "allowed" });
      else fresh.set(e.to, [...(fresh.get(e.to) ?? []), e]);
    }
    for (const [to, list] of fresh) {
      list.sort((x, y) => x.from.localeCompare(y.from));
      for (const e of list.slice(0, MAX_ALLOWED_PER_TARGET))
        edges.add({ from: e.from, to: e.to, kind: e.kind as EdgeKind, label: e.label.replace(/^service(?=:|$)/, "tcp"), evidence: [e.source], confidence: "allowed" });
      if (list.length > MAX_ALLOWED_PER_TARGET)
        notes.push(`security groups allow ${list.length} sources into ${ix.byKey.get(to)?.name ?? to}: showing ${MAX_ALLOWED_PER_TARGET}, the other ${list.length - MAX_ALLOWED_PER_TARGET} are only allowed by a group rule`);
    }
  }

  // CloudFormation stamps what it creates with the stack's ARN and the logical id: stack → resource ("manages").
  for (const r of resources) {
    const stack = Object.hasOwn(r.tags, "aws:cloudformation:stack-id") ? r.tags["aws:cloudformation:stack-id"] : undefined;
    if (!stack?.startsWith("arn:") || r.hidden) continue;
    const s = one(arnKeys(ix, stack));
    const logical = Object.hasOwn(r.tags, "aws:cloudformation:logical-id") ? r.tags["aws:cloudformation:logical-id"] : undefined;
    if (s && s !== r.key) edges.add({ from: s, to: r.key, kind: "manages", label: logical || undefined, evidence: ["tag aws:cloudformation:stack-id"], confidence: "config" });
  }

  // Names several resources answer to, which a reference named: none of them was linked — say so on each.
  for (const [host, list] of ix.ambiguous) {
    const claimants = list.map((k) => ix.byKey.get(k)).filter((r): r is Resource => !!r && r.kind !== "external");
    if (claimants.length < 2) continue;
    for (const r of claimants) {
      const had = Array.isArray(r.facts?.ambiguousHost) ? (r.facts.ambiguousHost as string[]) : [];
      r.facts = { ...(r.facts ?? {}), ambiguousHost: [...new Set([...had, host])] };
    }
    notes.push(`${host} is claimed by ${claimants.length} resources (${claimants.slice(0, 3).map((r) => r.name).join(", ")}${claimants.length > 3 ? ", …" : ""}) and no DNS record says which — references to it aren't linked`);
  }

  return { resources: [...resources, ...externals.values()], edges: edges.list(), notes, hiddenTypes };
}
