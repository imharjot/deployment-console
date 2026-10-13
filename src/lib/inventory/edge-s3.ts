// S3 as the cloud map sees it: the raw shapes the real and simulated S3 sources return, and the pure rules that turn a
// bucket's settings into a Resource plus Links (notifications → Lambda/SQS/SNS/EventBridge, access logs and
// replication → other buckets, a website redirect → a hostname, the default-encryption KMS key → the bucket). Also
// object-key validation and the listing rules the simulated account uses. Pure — no AWS calls.
import { kmsRef } from "./compute-common.ts";
import { bucketArn, lambdaFunctionArn, normHost, s3Endpoints, websiteEndpoint } from "./edge-hosts.ts";
import type { EnrichState, Link, Prop, Resource } from "./types.ts";

export interface RawBucket {
  name: string;
  region: string;
  createdAt?: number;
}

export interface BucketNotification {
  type: "lambda" | "sqs" | "sns" | "eventbridge";
  target?: string; // function / queue / topic ARN (EventBridge: none, it's always the region's default bus)
  events: string[]; // "s3:ObjectCreated:*"
  prefix?: string;
  suffix?: string;
  id?: string;
}

// What discovery could read about one bucket. A setting listed in `unread` is unknown, not absent.
export interface BucketSettings {
  tags?: Record<string, string>;
  notifications?: BucketNotification[];
  website?: { index?: string; redirectAll?: string };
  policyPublic?: boolean; // GetBucketPolicyStatus: the bucket policy grants public access
  blockPublic?: { blockAcls: boolean; ignoreAcls: boolean; blockPolicy: boolean; restrict: boolean }; // bucket-level
  encryption?: { algorithm: string; kmsKey?: string; bucketKey?: boolean };
  versioning?: "Enabled" | "Suspended" | "Off";
  logging?: { bucket: string; prefix: string };
  replication?: { id?: string; status: string; bucket: string; storageClass?: string }[];
  lastActivityAt?: number; // only when cheaply known (the simulated account); never guessed
  unread: string[]; // "tags", "encryption"… — couldn't be read (denied, other error)
  denied: string[]; // IAM actions AWS refused ("s3:GetBucketTagging")
}

export interface S3Object {
  key: string;
  size: number;
  lastModified?: number;
  storageClass?: string;
}
export interface ObjectPage {
  prefixes: string[]; // "folders" under the prefix (delimiter "/")
  objects: S3Object[];
  next?: string; // continuation token
}

// Wraps calls in the shared concurrency limit and the discovery deadline (actions pass a pass-through).
export interface Io {
  limit<T>(fn: () => Promise<T>): Promise<T>;
  signal?: AbortSignal;
}

// One door per source (real SDK / simulated account), so both run the same mapping code.
export interface S3Api {
  buckets(io: Io, cap: number): Promise<{ buckets: RawBucket[]; truncated: boolean }>;
  settings(b: RawBucket, io: Io): Promise<BucketSettings>;
  tags(b: RawBucket): Promise<Record<string, string>>; // live, for protection right before a write (R01): {} when it has none
  objects(b: RawBucket, o: { prefix?: string; token?: string; max: number }, io: Io): Promise<ObjectPage>;
  put(b: RawBucket, o: { key: string; body: Uint8Array; contentType?: string; overwrite: boolean }): Promise<{ etag?: string; versionId?: string }>;
  remove(b: RawBucket, key: string): Promise<{ deleteMarker?: boolean; versionId?: string }>;
  presign(b: RawBucket, key: string, seconds: number): Promise<string>;
}

// Effective public state, from the bucket policy and the bucket's own Block Public Access (the account-level block
// and ACL grants aren't read — see docs).
export function publicState(s: BucketSettings | undefined): "public" | "blocked" | "private" | "unknown" {
  if (!s) return "unknown";
  const b = s.blockPublic;
  if (b && b.blockPolicy && b.restrict && b.blockAcls && b.ignoreAcls) return "blocked";
  if (s.policyPublic === undefined) return s.unread.includes("policy status") ? "unknown" : "private";
  return s.policyPublic && !b?.restrict ? "public" : "private";
}

// "s3:ObjectCreated:* prefix uploads/ suffix .jpg"
export const notificationEvidence = (n: BucketNotification) =>
  [n.events.join(", ") || "all events", n.prefix ? `prefix ${n.prefix}` : "", n.suffix ? `suffix ${n.suffix}` : ""].filter(Boolean).join(" ");

export function notificationLinks(bucketKey: string, region: string, list: BucketNotification[], accountId?: string): Link[] {
  const out: Link[] = [];
  for (const n of list) {
    const to = n.type === "eventbridge" ? (accountId ? `arn:aws:events:${region}:${accountId}:event-bus/default` : undefined) : n.type === "lambda" && n.target ? lambdaFunctionArn(n.target) : n.target;
    if (!to) continue;
    const label = n.events.map((e) => e.replace(/^s3:/, "")).join(", ") || undefined;
    out.push({ from: bucketKey, to, kind: "event", label, evidence: n.type === "eventbridge" ? "S3 → EventBridge (all bucket events)" : notificationEvidence(n) });
  }
  return out;
}

const ENC: Record<string, string> = { AES256: "SSE-S3 (AES-256)", "aws:kms": "SSE-KMS", "aws:kms:dsse": "DSSE-KMS" };
const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : undefined);

// Why a bucket's settings are missing, by how far discovery got with them (R18).
const UNREAD: Record<EnrichState, string> = {
  ok: "settings not read during discovery (scan limit or deadline) — open the panel",
  capped: "settings not read during discovery (more buckets than it reads) — open the panel",
  skipped: "settings not read during discovery (time budget) — open the panel",
  denied: "settings not readable (permission denied)",
  error: "settings couldn't be read during discovery — open the panel",
};

// The key S3 encrypts new objects with by default: the named key, or the account's AWS-managed aws/s3 key when SSE-KMS
// names none.
export const encryptionKey = (enc: BucketSettings["encryption"], region: string, accountId?: string) =>
  enc && enc.algorithm.startsWith("aws:kms") ? kmsRef(enc.kmsKey ?? "alias/aws/s3", region, accountId) : undefined;

// `state`: how discovery's settings read went for this bucket (absent: not attempted yet — a checkpointed base list).
export function bucketResource(b: RawBucket, s: BucketSettings | undefined, accountId?: string, state?: EnrichState): { resource: Resource; links: Link[] } {
  const key = bucketArn(b.name);
  const links: Link[] = [];
  const props: Prop[] = [{ label: "Region", value: b.region }];
  const pub = publicState(s);
  let health: Resource["health"] = s ? "ok" : "unknown";
  let healthReason = s ? undefined : UNREAD[state ?? "ok"];

  if (s) {
    const unknown = (k: string) => s.unread.includes(k);
    props.push({
      label: "Public access",
      value: pub === "blocked" ? "Blocked (Block Public Access)" : pub === "public" ? (s.website ? "Public (website)" : "Public via bucket policy") : pub === "private" ? "Not public" : "Unknown",
    });
    if (s.website) {
      props.push(s.website.redirectAll
        ? { label: "Website", value: `redirects all requests to ${s.website.redirectAll}`, mono: true }
        : { label: "Website", value: websiteEndpoint(b.name, b.region), mono: true });
      if (s.website.redirectAll) links.push({ from: key, to: normHost(s.website.redirectAll), kind: "route", label: "website redirect", evidence: `website redirects all requests to ${s.website.redirectAll}` });
    }
    if (pub === "public" && !s.website) {
      health = "warning";
      healthReason = "public via bucket policy, but no website is configured";
    }
    if (s.versioning) props.push({ label: "Versioning", value: s.versioning });
    else if (unknown("versioning")) props.push({ label: "Versioning", value: "unknown" });
    if (s.encryption) props.push({ label: "Encryption", value: `${ENC[s.encryption.algorithm] ?? s.encryption.algorithm}${s.encryption.kmsKey ? ` · ${s.encryption.kmsKey}` : ""}`, mono: !!s.encryption.kmsKey });
    const kms = encryptionKey(s.encryption, b.region, accountId);
    if (kms) links.push({ from: kms, to: key, kind: "encrypts", label: "default encryption", evidence: `bucket default encryption ${ENC[s.encryption!.algorithm] ?? s.encryption!.algorithm}${s.encryption!.kmsKey ? "" : " (AWS-managed aws/s3 key)"}` });
    if (s.logging) {
      props.push({ label: "Access logs", value: `${s.logging.bucket}/${s.logging.prefix}`, mono: true });
      links.push({ from: key, to: bucketArn(s.logging.bucket), kind: "writes", label: "access logs", evidence: `server access logs → ${s.logging.bucket}/${s.logging.prefix}` });
    }
    for (const r of s.replication ?? []) {
      const dest = r.bucket.startsWith("arn:") ? r.bucket : bucketArn(r.bucket);
      links.push({ from: key, to: dest, kind: "writes", label: "replication", evidence: `replication rule ${r.id ?? "(unnamed)"} (${r.status})${r.storageClass ? ` → ${r.storageClass}` : ""}` });
    }
    if (s.replication?.length) props.push({ label: "Replication", value: s.replication.map((r) => `${r.bucket.replace(/^arn:aws[a-z-]*:s3:::/, "")} (${r.status})`).join(", "), mono: true });
    const notes = s.notifications ?? [];
    if (notes.length) {
      const count = (t: BucketNotification["type"]) => notes.filter((n) => n.type === t).length;
      const parts = [["Lambda", count("lambda")], ["SQS", count("sqs")], ["SNS", count("sns")], ["EventBridge", count("eventbridge")]].filter(([, n]) => n).map(([l, n]) => `${l} ×${n}`);
      props.push({ label: "Notifications", value: parts.join(", ") });
      links.push(...notificationLinks(key, b.region, notes, accountId));
    }
    if (s.unread.length) props.push({ label: "Not readable", value: s.unread.join(", ") });
  }
  if (b.createdAt) props.push({ label: "Created", value: day(b.createdAt)! });
  // R01: tags that weren't read are unknown, not absent — protection fails closed on them.
  const tagsUnread = !s || s.tags === undefined;
  const enrichment: Record<string, EnrichState> | undefined = state
    ? { settings: state, ...(s && s.tags === undefined ? { tags: s.denied.includes("s3:GetBucketTagging") ? "denied" : "error" } : {}) }
    : undefined;

  return {
    resource: {
      key,
      kind: "s3",
      provider: "s3",
      name: b.name,
      region: b.region,
      tags: s?.tags ?? {},
      ...(tagsUnread ? { tagsUnread } : {}),
      ...(enrichment ? { enrichment } : {}),
      health,
      healthReason,
      props,
      endpoints: s3Endpoints(b.name, b.region, !!s?.website),
      aliases: [b.name, `s3://${b.name}`, key],
      lastActivityAt: s?.lastActivityAt,
      consoleUrl: `https://console.aws.amazon.com/s3/buckets/${encodeURIComponent(b.name)}?region=${b.region}`,
      createdAt: b.createdAt,
    },
    links,
  };
}

// GetBucketLocation: empty = us-east-1, "EU" = eu-west-1 (legacy), anything else is the region.
export const locationRegion = (lc?: string | null) => (!lc ? "us-east-1" : lc === "EU" ? "eu-west-1" : lc);

// Object keys typed by a person: 1–1024 bytes, no control characters, no leading slash (S3 allows one, but it's
// almost always a mistake that creates an empty-named folder).
export function objectKeyError(key: unknown): string | undefined {
  if (typeof key !== "string" || !key) return "key is required";
  if (new TextEncoder().encode(key).length > 1024) return "key is longer than 1,024 bytes";
  if (/[\u0000-\u001f\u007f]/.test(key)) return "key contains control characters";
  if (key.startsWith("/")) return "key must not start with /";
  // Env files hold services' settings and secrets (ECS environmentFiles, the console's own): they are read and edited
  // only through a service's Variables tab — audited, values never shown in plans — not as plain objects.
  if (/(^|\/)\.env([.-][^/]*)?$|\.env$/i.test(key)) return "env files are read and edited in a service's Variables tab, not here";
  return undefined;
}

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BASE64 = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;

// Strict base64 (no data: prefix, no whitespace) → bytes, or why not.
export function decodeUpload(b64: unknown): { bytes: Uint8Array } | { error: string } {
  if (typeof b64 !== "string") return { error: "contentBase64 is required" };
  if (b64.length > MAX_UPLOAD_BASE64) return { error: "content is larger than 8 MB" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return { error: "contentBase64 is not valid base64" };
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  if (bytes.length > MAX_UPLOAD_BYTES) return { error: "content is larger than 8 MB" };
  return { bytes };
}

export const contentTypeError = (ct: unknown) =>
  ct === undefined ? undefined : typeof ct === "string" && ct.length <= 200 && /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(ct) ? undefined : "contentType must look like type/subtype";

// A prefix people browse with: ≤ 1,024 chars, no control characters.
export const prefixError = (p: unknown) =>
  p === undefined || p === "" ? undefined : typeof p !== "string" || p.length > 1024 || /[\u0000-\u001f\u007f]/.test(p) ? "invalid prefix" : undefined;

// ListObjectsV2 semantics over a sorted key list (delimiter "/"), for the simulated account. The token is the last
// key or prefix returned.
export function listPage(all: S3Object[], o: { prefix?: string; token?: string; max: number }): ObjectPage {
  const prefix = o.prefix ?? "";
  const rows: ({ prefix: string } | { obj: S3Object })[] = [];
  const seen = new Set<string>();
  for (const obj of [...all].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (!obj.key.startsWith(prefix)) continue;
    const rest = obj.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const p = prefix + rest.slice(0, slash + 1);
      if (!seen.has(p)) {
        seen.add(p);
        rows.push({ prefix: p });
      }
    } else rows.push({ obj });
  }
  const id = (r: (typeof rows)[number]) => ("prefix" in r ? r.prefix : r.obj.key);
  const start = o.token ? rows.findIndex((r) => id(r) > o.token!) : 0;
  const page = start < 0 ? [] : rows.slice(start, start + o.max);
  const more = start >= 0 && start + o.max < rows.length;
  return {
    prefixes: page.flatMap((r) => ("prefix" in r ? [r.prefix] : [])),
    objects: page.flatMap((r) => ("obj" in r ? [r.obj] : [])),
    next: more && page.length ? id(page[page.length - 1]) : undefined,
  };
}

export const humanBytes = (n: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${u[i]}`;
};
