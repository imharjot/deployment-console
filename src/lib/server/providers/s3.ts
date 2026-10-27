// S3 provider: every bucket the account owns (all regions, each marked with its own), the settings that matter on a
// map — public access, website, versioning, encryption — and the links S3 stores explicitly: event notifications →
// Lambda / SQS / SNS / EventBridge, server access logs and replication → other buckets, a website redirect → a host,
// the default-encryption KMS key → the bucket. Global: one run lists every bucket. The bucket list is handed over first
// (ctx.checkpoint); settings (9 reads per bucket) follow item by item within the time budget, and a bucket whose
// settings weren't read keeps its tags marked unread (R18, R01).
// The panel lists the top of the bucket (keys, sizes, dates — never contents). Actions upload, delete and hand out a
// 5-minute download link; object contents are reachable only through that audited link (s3:GetObject is a sensitive
// permission, not part of the read-only policy), and the audit log records which object, never the link (R08).
import "server-only";
import {
  DeleteObjectCommand, GetBucketEncryptionCommand, GetBucketLocationCommand, GetBucketLoggingCommand, GetBucketNotificationConfigurationCommand,
  GetBucketPolicyStatusCommand, GetBucketReplicationCommand, GetBucketTaggingCommand, GetBucketVersioningCommand, GetBucketWebsiteCommand,
  GetPublicAccessBlockCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type NotificationConfiguration,
} from "@aws-sdk/client-s3";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { rfc3986, s3ObjectUrl } from "../../inventory/edge-hosts.ts";
import {
  bucketResource, contentTypeError, decodeUpload, humanBytes, locationRegion, MAX_UPLOAD_BASE64, objectKeyError, prefixError,
  publicState, type BucketNotification, type BucketSettings, type RawBucket, type S3Api,
} from "../../inventory/edge-s3.ts";
import { keys, type Link, type Prop, type Resource, type ResourceDetail } from "../../inventory/types.ts";
import { homeRegion } from "../sources.ts";
import { abortOf, errMsg, errName, field, fmtTime, ioOf, once, propOf, retry, writeOpts } from "./edge-util.ts";
import { EXISTING, S3 } from "./mock-names.ts";
import { mockS3 } from "./mock/s3.ts";
import { budget, enrich, perRegion } from "./serverless-util.ts";
import type { Provider, ProviderAction, ProviderContext } from "./types.ts";

const DEEP_CAP = 300; // buckets whose settings discovery reads (9 calls each); the rest load when their panel opens
const LINK_SECONDS = 300; // download links live 5 minutes
const PAGE = 100; // objects per panel page

// ---- real source ----

// Per region and AWS connection (perRegion starts a new set after a switch); "global" or unknown: the home region.
const regionFor = (region: string) => (region && region !== "unknown" && region !== "global" ? region : homeRegion());
const readers = perRegion((r) => new S3Client({ region: r, followRegionRedirects: true, ...retry }), "s3");
const client = (region: string): S3Client => readers(regionFor(region));
// Uploads and deletes: sent once (F31).
const writers = perRegion((r) => new S3Client({ region: r, followRegionRedirects: true, ...once }), "s3");
const writer = (region: string): S3Client => writers(regionFor(region));

function notifications(n: NotificationConfiguration): BucketNotification[] {
  const filter = (f?: { Key?: { FilterRules?: { Name?: string; Value?: string }[] } }) => {
    const v = (name: string) => f?.Key?.FilterRules?.find((r) => r.Name?.toLowerCase() === name)?.Value || undefined;
    return { prefix: v("prefix"), suffix: v("suffix") };
  };
  return [
    ...(n.LambdaFunctionConfigurations ?? []).map((c) => ({ type: "lambda" as const, target: c.LambdaFunctionArn, events: c.Events ?? [], id: c.Id, ...filter(c.Filter) })),
    ...(n.QueueConfigurations ?? []).map((c) => ({ type: "sqs" as const, target: c.QueueArn, events: c.Events ?? [], id: c.Id, ...filter(c.Filter) })),
    ...(n.TopicConfigurations ?? []).map((c) => ({ type: "sns" as const, target: c.TopicArn, events: c.Events ?? [], id: c.Id, ...filter(c.Filter) })),
    ...(n.EventBridgeConfiguration ? [{ type: "eventbridge" as const, events: [] }] : []),
  ];
}

const realS3: S3Api = {
  async buckets(io, cap) {
    const out: RawBucket[] = [];
    let token: string | undefined, truncated = false;
    do {
      const r = await io.limit(() => client(homeRegion()).send(new ListBucketsCommand({ MaxBuckets: 1000, ContinuationToken: token }), abortOf(io)));
      for (const b of r.Buckets ?? []) {
        if (!b.Name) continue;
        if (out.length >= cap) {
          truncated = true;
          break;
        }
        out.push({ name: b.Name, region: b.BucketRegion ?? "", createdAt: b.CreationDate?.getTime() });
      }
      token = r.ContinuationToken;
    } while (token && !truncated);
    // Endpoints that don't return BucketRegion: ask per bucket (a missing region beats a failed provider).
    await Promise.all(out.filter((b) => !b.region).map(async (b) => {
      try {
        const r = await io.limit(() => client(homeRegion()).send(new GetBucketLocationCommand({ Bucket: b.name }), abortOf(io)));
        b.region = locationRegion(r.LocationConstraint);
      } catch {
        b.region = "unknown";
      }
    }));
    return { buckets: out, truncated };
  },

  async settings(b, io) {
    const s: BucketSettings = { unread: [], denied: [] };
    const c = client(b.region), Bucket = b.name;
    // A value; null when S3 says "not configured"; undefined when unreadable (recorded in unread / denied).
    const read = async <T,>(what: string, action: string, absent: string | undefined, fn: () => Promise<T>): Promise<T | null | undefined> => {
      try {
        return await io.limit(() => {
          if (io.signal?.aborted) throw Object.assign(new Error("discovery deadline"), { name: "AbortError" });
          return fn();
        });
      } catch (e) {
        if (absent && errName(e) === absent) return null;
        s.unread.push(what);
        if (/AccessDenied|Forbidden|NotAuthorized/i.test(errName(e))) s.denied.push(action);
        return undefined;
      }
    };
    const [tags, notes, website, policy, pab, enc, ver, log, repl] = await Promise.all([
      read("tags", "s3:GetBucketTagging", "NoSuchTagSet", () => c.send(new GetBucketTaggingCommand({ Bucket }), abortOf(io))),
      read("notifications", "s3:GetBucketNotification", undefined, () => c.send(new GetBucketNotificationConfigurationCommand({ Bucket }), abortOf(io))),
      read("website", "s3:GetBucketWebsite", "NoSuchWebsiteConfiguration", () => c.send(new GetBucketWebsiteCommand({ Bucket }), abortOf(io))),
      read("policy status", "s3:GetBucketPolicyStatus", "NoSuchBucketPolicy", () => c.send(new GetBucketPolicyStatusCommand({ Bucket }), abortOf(io))),
      read("public access block", "s3:GetBucketPublicAccessBlock", "NoSuchPublicAccessBlockConfiguration", () => c.send(new GetPublicAccessBlockCommand({ Bucket }), abortOf(io))),
      read("encryption", "s3:GetEncryptionConfiguration", "ServerSideEncryptionConfigurationNotFoundError", () => c.send(new GetBucketEncryptionCommand({ Bucket }), abortOf(io))),
      read("versioning", "s3:GetBucketVersioning", undefined, () => c.send(new GetBucketVersioningCommand({ Bucket }), abortOf(io))),
      read("logging", "s3:GetBucketLogging", undefined, () => c.send(new GetBucketLoggingCommand({ Bucket }), abortOf(io))),
      read("replication", "s3:GetReplicationConfiguration", "ReplicationConfigurationNotFoundError", () => c.send(new GetBucketReplicationCommand({ Bucket }), abortOf(io))),
    ]);
    if (io.signal?.aborted) throw Object.assign(new Error("discovery deadline"), { name: "AbortError" });
    if (tags !== undefined) s.tags = Object.fromEntries((tags?.TagSet ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]).filter(([k]) => k));
    if (notes) s.notifications = notifications(notes);
    if (website) s.website = { index: website.IndexDocument?.Suffix, redirectAll: website.RedirectAllRequestsTo?.HostName };
    if (policy !== undefined) s.policyPublic = policy?.PolicyStatus?.IsPublic === true;
    const p = pab?.PublicAccessBlockConfiguration;
    if (p) s.blockPublic = { blockAcls: !!p.BlockPublicAcls, ignoreAcls: !!p.IgnorePublicAcls, blockPolicy: !!p.BlockPublicPolicy, restrict: !!p.RestrictPublicBuckets };
    const rule = enc?.ServerSideEncryptionConfiguration?.Rules?.[0];
    const def = rule?.ApplyServerSideEncryptionByDefault;
    if (def?.SSEAlgorithm) s.encryption = { algorithm: def.SSEAlgorithm, kmsKey: def.KMSMasterKeyID, bucketKey: rule?.BucketKeyEnabled };
    if (ver) s.versioning = ver.Status === "Enabled" ? "Enabled" : ver.Status === "Suspended" ? "Suspended" : "Off";
    if (log?.LoggingEnabled?.TargetBucket) s.logging = { bucket: log.LoggingEnabled.TargetBucket, prefix: log.LoggingEnabled.TargetPrefix ?? "" };
    if (repl !== undefined) {
      s.replication = (repl?.ReplicationConfiguration?.Rules ?? []).flatMap((r) =>
        r.Destination?.Bucket ? [{ id: r.ID, status: r.Status ?? "Enabled", bucket: r.Destination.Bucket, storageClass: r.Destination.StorageClass }] : []);
    }
    return s;
  },

  async tags(b) {
    try {
      const r = await client(b.region).send(new GetBucketTaggingCommand({ Bucket: b.name }), abortOf());
      return Object.fromEntries((r.TagSet ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]).filter(([k]) => k));
    } catch (e) {
      if (errName(e) === "NoSuchTagSet") return {}; // a bucket without tags answers with an error
      throw e;
    }
  },

  async objects(b, o, io) {
    const r = await io.limit(() =>
      client(b.region).send(new ListObjectsV2Command({ Bucket: b.name, Prefix: o.prefix || undefined, Delimiter: "/", MaxKeys: o.max, ContinuationToken: o.token }), abortOf(io)));
    return {
      prefixes: (r.CommonPrefixes ?? []).flatMap((p) => (p.Prefix ? [p.Prefix] : [])),
      objects: (r.Contents ?? []).flatMap((c) => (c.Key ? [{ key: c.Key, size: c.Size ?? 0, lastModified: c.LastModified?.getTime(), storageClass: c.StorageClass }] : [])),
      next: r.IsTruncated ? r.NextContinuationToken : undefined,
    };
  },

  async put(b, o) {
    // IfNoneMatch "*": S3 refuses to replace an existing key unless the person asked to overwrite.
    const r = await writer(b.region).send(
      new PutObjectCommand({ Bucket: b.name, Key: o.key, Body: o.body, ContentType: o.contentType, IfNoneMatch: o.overwrite ? undefined : "*" }),
      writeOpts(60_000), // up to 8 MB
    );
    return { etag: r.ETag, versionId: r.VersionId };
  },

  async remove(b, key) {
    const r = await writer(b.region).send(new DeleteObjectCommand({ Bucket: b.name, Key: key }), writeOpts());
    return { deleteMarker: r.DeleteMarker, versionId: r.VersionId };
  },

  // A SigV4 query-string presigned GET, signed locally with the console's own credentials (no request is made).
  async presign(b, key, seconds) {
    const region = regionFor(b.region);
    const { host, path } = s3ObjectUrl(b.name, region, key);
    const signer = new SignatureV4({ credentials: client(region).config.credentials, region, service: "s3", sha256: Hash.bind(null, "sha256"), uriEscapePath: false, applyChecksum: false });
    const signed = await signer.presign(
      new HttpRequest({ protocol: "https:", hostname: host, method: "GET", path, headers: { host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" } }),
      { expiresIn: seconds },
    );
    const qs = Object.entries(signed.query ?? {}).flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string").map((x) => `${rfc3986(k)}=${rfc3986(x)}`));
    return `https://${host}${signed.path}?${qs.join("&")}`;
  },
};

const api = (mock: boolean): S3Api => (mock ? mockS3 : realS3);
const rawOf = (r: Resource): RawBucket => ({ name: r.name, region: r.region });

// The ELB side doesn't read load-balancer access-log attributes yet; the simulated account shows that link so its
// story ("the logs bucket collects ALB and CloudFront logs") is complete. Real mode never emits it from here.
const MOCK_EXTRA_LINKS: Link[] = [
  { from: keys.loadBalancer(EXISTING.alb.name), to: S3.logs.arn, kind: "writes", label: "access logs", evidence: `ALB access logs → ${S3.logs.name}/alb/` },
];

// ---- panel ----

function settingsRows(r: Resource, s: BucketSettings | undefined): Prop[] {
  if (!s) return [{ label: "Settings", value: "couldn't be read" }];
  const b = s.blockPublic;
  const on = b ? [b.blockAcls && "block new ACLs", b.ignoreAcls && "ignore ACLs", b.blockPolicy && "block public policies", b.restrict && "restrict public buckets"].filter(Boolean) : [];
  const pub = publicState(s);
  return [
    { label: "Region", value: r.region },
    { label: "Public access", value: pub === "public" ? (s.website ? "public (website)" : "public via bucket policy") : pub === "blocked" ? "blocked" : pub === "private" ? "not public" : "unknown" },
    { label: "Block Public Access (bucket)", value: !b ? (s.unread.includes("public access block") ? "unknown" : "not configured") : on.length === 4 ? "all four settings on" : on.join(", ") || "all off" },
    { label: "Bucket policy", value: s.policyPublic === undefined ? (s.unread.includes("policy status") ? "unknown" : "none") : s.policyPublic ? "grants public access" : "not public" },
    { label: "Website", value: s.website ? (s.website.redirectAll ? `redirects to ${s.website.redirectAll}` : `index ${s.website.index ?? "—"}`) : s.unread.includes("website") ? "unknown" : "off" },
    { label: "Versioning", value: s.versioning ?? "unknown" },
    { label: "Encryption", value: s.encryption ? `${s.encryption.algorithm}${s.encryption.kmsKey ? ` (${s.encryption.kmsKey})` : ""}${s.encryption.bucketKey ? ", bucket key" : ""}` : s.unread.includes("encryption") ? "unknown" : "default" },
    { label: "Access logs", value: s.logging ? `${s.logging.bucket}/${s.logging.prefix}` : s.unread.includes("logging") ? "unknown" : "off", mono: !!s.logging },
    { label: "Replication", value: s.replication?.length ? s.replication.map((x) => `${x.bucket} (${x.status})`).join(", ") : s.unread.includes("replication") ? "unknown" : "none", mono: !!s.replication?.length },
    ...(s.unread.length ? [{ label: "Not readable", value: s.unread.join(", ") }] : []),
  ];
}

// Objects at a prefix. The provider contract passes (r, ctx) today; the optional third argument lets the map's detail
// route add ?prefix=…&token=… browsing without another code path.
async function detail(r: Resource, ctx: ProviderContext, q?: { prefix?: string; token?: string }): Promise<ResourceDetail> {
  const bad = prefixError(q?.prefix);
  if (bad) throw new Error(bad);
  const a = api(ctx.mock), b = rawOf(r), io = ioOf(ctx);
  const [s, page] = await Promise.all([
    a.settings(b, io).catch(() => undefined),
    a.objects(b, { prefix: q?.prefix, token: q?.token, max: PAGE }, io).catch((e: unknown) => new Error(/AccessDenied/i.test(errName(e)) ? "needs s3:ListBucket" : errMsg(e))),
  ]);
  const where = q?.prefix ? `under ${q.prefix}` : "at the top level";
  const sections: ResourceDetail["sections"] = [{ title: "Settings", rows: settingsRows(r, s) }];
  const notes = s?.notifications ?? [];
  if (notes.length) {
    sections.push({
      title: "Event notifications",
      table: { columns: ["Destination", "Target", "Events", "Filter"], rows: notes.map((n) => [n.type, n.target ?? "default event bus", n.events.join(", ") || "all", [n.prefix && `prefix ${n.prefix}`, n.suffix && `suffix ${n.suffix}`].filter(Boolean).join(" ") || "—"]) },
    });
  }
  if (page instanceof Error) sections.push({ title: "Objects", note: `Couldn't list objects: ${page.message}` });
  else {
    sections.push({
      title: "Objects",
      table: {
        columns: ["Key", "Size", "Last modified", "Class"],
        rows: [...page.prefixes.map((p) => [p, "folder", "", ""]), ...page.objects.map((o) => [o.key, humanBytes(o.size), fmtTime(o.lastModified), o.storageClass ?? ""])],
      },
      note: `${page.prefixes.length + page.objects.length ? `First ${page.prefixes.length + page.objects.length} entries ${where}` : `Nothing ${where}`}${page.next ? " — more exist." : "."} Contents open only through the audited download link.`,
    });
  }
  return { key: r.key, sections };
}

// ---- actions ----

type UploadInput = { key: string; contentBase64: string; contentType?: string; overwrite?: boolean };
type KeyInput = { key: string };
const regionUnknown = (r: Resource) => (r.region === "unknown" ? "the bucket's region couldn't be read" : undefined);
const keySchema = field({ type: "string", title: "S3 object key", minLength: 1, maxLength: 1024, description: "Object key, e.g. uploads/2026/report.pdf (no leading /)." });
const check = (err: string | undefined) => {
  if (err) throw new Error(err);
};

// Own string field of an action result (never trusts inherited keys).
const own = (o: unknown, k: string): string | undefined =>
  o && typeof o === "object" && Object.hasOwn(o, k) && typeof (o as Record<string, unknown>)[k] === "string" ? ((o as Record<string, string>)[k]) : undefined;
const isPublic = (r: Resource) => (propOf(r, "Public access") ?? "").toLowerCase().startsWith("public");
// The object the action changes, as a lock target (mutation-keys: s3:<bucket>/<key>), so two changes of one object
// never overlap — whichever surface makes them.
const objectTarget = (r: Resource, i: KeyInput) => (typeof i?.key === "string" && i.key ? [`arn:aws:s3:::${r.name}/${i.key}`] : []);

const upload: ProviderAction<UploadInput> = {
  id: "upload-object",
  kind: "s3",
  title: "Upload an object",
  summary: "Uploads one file (up to 8 MB) to this bucket; an existing object is replaced only when you ask for it.",
  description: "Uploads one object (≤ 8 MB, base64) to the bucket. Refuses to replace an existing key unless overwrite is true. Returns the key, size, ETag and version id.",
  risk: "change",
  perm: "provision",
  iam: ["s3:PutObject"],
  undo: "Delete the object again; with versioning on, an overwritten object's previous version stays restorable",
  verifies: "S3 answers with the new object's ETag (and version id when versioning is on)",
  retrySafe: true, // the same bytes under the same key; without overwrite a second attempt is refused
  input: {
    type: "object",
    additionalProperties: false,
    required: ["key", "contentBase64"],
    properties: {
      key: keySchema,
      contentBase64: field({ type: "string", title: "File", maxLength: MAX_UPLOAD_BASE64, description: "The file's bytes, base64-encoded (≤ 8 MB decoded)." }),
      contentType: field({ type: "string", title: "Content type (optional)", maxLength: 200, description: "MIME type, e.g. image/png. Default: binary/octet-stream." }),
      overwrite: field({ type: "boolean", title: "Replace an existing object", default: false, description: "Replace an existing object with the same key." }),
    },
  },
  secretFields: ["contentBase64"], // not secret, but never echoed into approvals or the audit log
  targets: objectTarget,
  auditSummary: (res, i) => {
    const o = (res ?? {}) as { bytes?: number; versionId?: string };
    return { bucket: own(res, "bucket"), key: i.key, bytes: o.bytes, ...(o.versionId ? { versionId: o.versionId } : {}), overwrite: i.overwrite === true };
  },
  when: regionUnknown,
  async plan(r, i) {
    check(objectKeyError(i.key) ?? contentTypeError(i.contentType));
    const d = decodeUpload(i.contentBase64);
    if ("error" in d) throw new Error(d.error);
    const warnings: string[] = [];
    if (i.overwrite) warnings.push(propOf(r, "Versioning") === "Enabled" ? "Replaces an existing object with this key (versioning keeps the old one)." : "Replaces an existing object with this key — versioning is off, the old content is lost.");
    if (isPublic(r)) warnings.push("This bucket is public: anyone will be able to read the object.");
    return { summary: `Upload ${i.key} (${humanBytes(d.bytes.length)}) to ${r.name}`, changes: [`s3://${r.name}/${i.key}`], warnings };
  },
  async run(r, i, ctx) {
    check(objectKeyError(i.key) ?? contentTypeError(i.contentType));
    const d = decodeUpload(i.contentBase64);
    if ("error" in d) throw new Error(d.error);
    const out = await api(ctx.mock).put(rawOf(r), { key: i.key, body: d.bytes, contentType: i.contentType, overwrite: i.overwrite === true });
    return { bucket: r.name, key: i.key, bytes: d.bytes.length, etag: out.etag, versionId: out.versionId };
  },
};

const remove: ProviderAction<KeyInput> = {
  id: "delete-object",
  kind: "s3",
  title: "Delete an object",
  summary: "Deletes one object from this bucket — for good when versioning is off.",
  description: "Deletes one object by key. With versioning on, S3 adds a delete marker and earlier versions stay restorable; with versioning off the object is gone for good. Returns whether a delete marker was created.",
  risk: "danger",
  perm: "provision",
  iam: ["s3:DeleteObject"],
  undo: "With versioning on, delete the delete marker to restore it; with versioning off it is irreversible",
  verifies: "S3 confirms the delete (a delete marker id when versioning is on)",
  retrySafe: true, // deleting a deleted key changes nothing more
  input: { type: "object", additionalProperties: false, required: ["key"], properties: { key: keySchema } },
  targets: objectTarget,
  auditSummary: (res, i) => {
    const o = (res ?? {}) as { deleteMarker?: boolean; versionId?: string };
    return { bucket: own(res, "bucket"), key: i.key, deleteMarker: o.deleteMarker === true, ...(o.versionId ? { versionId: o.versionId } : {}) };
  },
  when: regionUnknown,
  async plan(r, i) {
    check(objectKeyError(i.key));
    const versioned = propOf(r, "Versioning") === "Enabled";
    return {
      summary: `Delete ${i.key} from ${r.name}`,
      changes: [`s3://${r.name}/${i.key}`],
      warnings: [versioned ? "Versioning is on: this adds a delete marker; earlier versions stay restorable." : "Versioning is off: the object is deleted permanently."],
    };
  },
  async run(r, i, ctx) {
    check(objectKeyError(i.key));
    const out = await api(ctx.mock).remove(rawOf(r), i.key);
    return { bucket: r.name, key: i.key, deleteMarker: !!out.deleteMarker, versionId: out.versionId };
  },
};

const download: ProviderAction<KeyInput> = {
  id: "download-object",
  kind: "s3",
  title: "Download an object",
  summary: `Creates a ${LINK_SECONDS / 60}-minute download link for one object; the audit log records which object, never the link.`,
  description: `Creates a presigned download link for one object, valid ${LINK_SECONDS / 60} minutes. The link exposes the object's contents to whoever holds it, so creating one is audited. Returns the URL and when it expires.`,
  risk: "change",
  perm: "env",
  iam: ["s3:GetObject"], // used by whoever opens the link, signed with the console's credentials
  undo: `Nothing to undo — the link expires after ${LINK_SECONDS / 60} minutes (it can't be revoked earlier)`,
  verifies: "The link opens the object until it expires",
  retrySafe: true, // signing makes no AWS call
  humanOnly: true, // hands out a link to the data: people only, never API tokens
  input: { type: "object", additionalProperties: false, required: ["key"], properties: { key: keySchema } },
  // R08: the bearer URL never reaches the audit log or the operation record — the object and the expiry do.
  auditSummary: (_res, i) => ({ bucket: own(_res, "bucket"), key: i.key, expiresInSeconds: LINK_SECONDS }),
  when: regionUnknown,
  async plan(r, i) {
    check(objectKeyError(i.key));
    return { summary: `Create a ${LINK_SECONDS / 60}-minute download link for s3://${r.name}/${i.key}`, warnings: ["Anyone holding the link can download the object until it expires."] };
  },
  async run(r, i, ctx) {
    check(objectKeyError(i.key));
    const url = await api(ctx.mock).presign(rawOf(r), i.key, LINK_SECONDS);
    return { bucket: r.name, key: i.key, url, expiresAt: Date.now() + LINK_SECONDS * 1000 };
  },
};

export const s3: Provider = {
  id: "s3",
  label: "S3",
  scope: "global", // ListBuckets answers for every region; each bucket carries its own
  kinds: ["s3"],
  covers: ["s3:bucket"],
  // IAM action names (several differ from the SDK command: ListBuckets → s3:ListAllMyBuckets, ListObjectsV2 →
  // s3:ListBucket, GetBucketNotificationConfiguration → s3:GetBucketNotification, GetPublicAccessBlock →
  // s3:GetBucketPublicAccessBlock, GetBucketEncryption → s3:GetEncryptionConfiguration, GetBucketReplication →
  // s3:GetReplicationConfiguration). s3:GetObject is what the presigned download link uses (no SDK command).
  read: [
    "s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:GetBucketTagging", "s3:GetBucketNotification", "s3:GetBucketWebsite", "s3:GetBucketPolicyStatus",
    "s3:GetBucketPublicAccessBlock", "s3:GetEncryptionConfiguration", "s3:GetBucketVersioning", "s3:GetBucketLogging", "s3:GetReplicationConfiguration", "s3:ListBucket",
  ],
  sensitive: ["s3:GetObject"],
  write: ["s3:PutObject", "s3:DeleteObject"],

  async discover(ctx) {
    const a = api(ctx.mock), io = ioOf(ctx);
    const { buckets, truncated } = await a.buckets(io, ctx.cap);
    if (truncated) ctx.note(`s3: showing the first ${ctx.cap.toLocaleString("en-US")} buckets`);
    // R18: the bucket list first — a deadline during the settings reads still shows every bucket (settings unread).
    ctx.checkpoint?.({ resources: buckets.map((b) => bucketResource(b, undefined, ctx.accountId).resource), links: [], mentions: [] });
    // F25: each bucket's settings start only while the time budget lasts; the rest stay unread (one note) and load when
    // their panel opens.
    const { results: settings, state } = await enrich(ctx, buckets, { label: "s3: bucket settings", max: DEEP_CAP, until: budget() }, (b) => a.settings(b, io));
    for (const d of new Set(settings.flatMap((s) => s?.denied ?? []))) ctx.note(`s3: permission ${d} is missing — some bucket settings aren't shown`);

    const resources: Resource[] = [], links: Link[] = [];
    buckets.forEach((b, i) => {
      const out = bucketResource(b, settings[i], ctx.accountId, state[i]);
      resources.push(out.resource);
      links.push(...out.links);
    });
    if (ctx.mock) links.push(...MOCK_EXTRA_LINKS);
    return { resources, links, mentions: [] };
  },

  // R01: the bucket's tags, read live right before a write (NoSuchTagSet → none). Any other failure refuses the write.
  async authoritative(r, ctx) {
    return { tags: await api(ctx.mock).tags(rawOf(r)) };
  },

  detail,
  actions: [upload, remove, download] as ProviderAction[],
};
