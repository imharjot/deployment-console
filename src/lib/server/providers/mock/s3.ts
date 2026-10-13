// Simulated S3 for the Acme demo account: the buckets named in ../mock-names.ts, their settings (the uploads buckets
// notify the thumbnailer Lambdas, the logs bucket collects ALB + CloudFront access logs, the old backups bucket hasn't
// been written for 400 days and is still encrypted with the legacy KMS key that is pending deletion, the assets bucket
// replicates to its eu-west-1 copy, the data lake holds Glue, Athena and Firehose output) and a few objects each. S3 is global: one listing holds every region's buckets.
// Object uploads and deletes change the state, kept on globalThis so every Next bundle sees the same buckets.
import type { BucketSettings, ObjectPage, RawBucket, S3Api, S3Object } from "../../../inventory/edge-s3.ts";
import { listPage } from "../../../inventory/edge-s3.ts";
import { ACCT, EU, GLUE, KMS_KEYS, LAMBDA, REGION, S3 } from "../mock-names.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const KB = 1024, MB = 1024 * KB, GB = 1024 * MB;
const ALL_BLOCKED = { blockAcls: true, ignoreAcls: true, blockPolicy: true, restrict: true };

interface MockObject extends S3Object {
  contentType?: string;
  body?: Uint8Array; // only for small objects uploaded in the demo
}
interface MockBucket extends RawBucket {
  settings: Omit<BucketSettings, "lastActivityAt" | "unread" | "denied">;
  objects: Map<string, MockObject>;
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

function seed(): Map<string, MockBucket> {
  const now = Date.now();
  const objs = (list: [string, number, number, string?][]) =>
    new Map(list.map(([key, size, ago, storageClass]) => [key, { key, size, lastModified: now - ago, storageClass: storageClass ?? "STANDARD" }]));
  const today = ymd(now).replaceAll("-", "/"), yesterday = ymd(now - DAY).replaceAll("-", "/");
  const albLogs = `alb/AWSLogs/${ACCT}/elasticloadbalancing/${REGION}/${today}`;
  const buckets: MockBucket[] = [
    {
      name: S3.assets.name, region: REGION, createdAt: now - 700 * DAY,
      settings: {
        tags: { Environment: "production", Purpose: "storefront static assets" }, blockPublic: ALL_BLOCKED, policyPublic: false, versioning: "Enabled", encryption: { algorithm: "AES256" },
        replication: [{ id: "assets-to-eu", status: "Enabled", bucket: EU.s3Replica.arn, storageClass: "STANDARD" }],
      },
      objects: objs([
        ["index.html", 3.2 * KB, 3 * DAY], ["favicon.ico", 15 * KB, 90 * DAY], ["robots.txt", 68, 200 * DAY],
        ["static/app.3f9c2e1.js", 412 * KB, 3 * DAY], ["static/app.3f9c2e1.css", 58 * KB, 3 * DAY], ["static/vendor.81ad0c4.js", 1.1 * MB, 21 * DAY],
        ["images/logo.svg", 4 * KB, 120 * DAY], ["images/hero-autumn.webp", 380 * KB, 10 * DAY],
      ]),
    },
    {
      name: S3.uploads.name, region: REGION, createdAt: now - 650 * DAY,
      settings: {
        tags: { Environment: "production" }, blockPublic: ALL_BLOCKED, policyPublic: false, versioning: "Enabled",
        encryption: { algorithm: "aws:kms", kmsKey: KMS_KEYS.app.arn, bucketKey: true },
        notifications: [{ type: "lambda", target: LAMBDA.thumbnailerProd.arn, events: ["s3:ObjectCreated:*"], prefix: "uploads/", id: "make-thumbnails" }],
      },
      objects: objs([
        [`uploads/${today}/7f3a9c.jpg`, 2.4 * MB, 4 * MIN], [`uploads/${today}/0b8e1d.png`, 860 * KB, 38 * MIN], [`uploads/${yesterday}/c41f07.jpg`, 3.1 * MB, DAY],
        [`thumbnails/${today}/7f3a9c-320.webp`, 22 * KB, 4 * MIN], [`thumbnails/${today}/0b8e1d-320.webp`, 18 * KB, 37 * MIN],
      ]),
    },
    {
      name: S3.uploadsStaging.name, region: REGION, createdAt: now - 400 * DAY,
      settings: {
        tags: { Environment: "staging" }, blockPublic: ALL_BLOCKED, policyPublic: false, versioning: "Off", encryption: { algorithm: "AES256" },
        notifications: [{ type: "lambda", target: LAMBDA.thumbnailerStaging.arn, events: ["s3:ObjectCreated:*"], prefix: "uploads/", id: "make-thumbnails" }],
      },
      objects: objs([["uploads/test-cat.jpg", 1.2 * MB, 6 * HOUR], ["thumbnails/test-cat-320.webp", 14 * KB, 6 * HOUR]]),
    },
    {
      name: S3.logs.name, region: REGION, createdAt: now - 720 * DAY,
      settings: { tags: { Purpose: "access logs" }, blockPublic: ALL_BLOCKED, policyPublic: false, versioning: "Off", encryption: { algorithm: "AES256" } },
      objects: objs([
        [`${albLogs}/${ACCT}_elasticloadbalancing_${REGION}_app.acme-production.5f2c1a9d3e7b4c60_${ymd(now).replaceAll("-", "")}T1005Z_10.0.3.41_1a2b3c4d.log.gz`, 184 * KB, 3 * MIN],
        [`cloudfront/shop/E2ACME1SHOP.${ymd(now)}-10.a1b2c3d4.gz`, 96 * KB, 7 * MIN],
        [`cloudfront/shop/E2ACME1SHOP.${ymd(now)}-09.e5f6a7b8.gz`, 131 * KB, 67 * MIN],
      ]),
    },
    {
      name: S3.backupsOld.name, region: REGION, createdAt: now - 1100 * DAY,
      settings: { tags: { Purpose: "database backups" }, blockPublic: ALL_BLOCKED, policyPublic: false, versioning: "Suspended", encryption: { algorithm: "aws:kms", kmsKey: KMS_KEYS.legacy.arn } },
      objects: objs([
        ["db/acme-2025-06-30.dump.gz", 4.2 * GB, 455 * DAY, "GLACIER"], ["db/acme-2025-08-18.dump.gz", 4.6 * GB, 405 * DAY, "GLACIER"], ["README.txt", 1.1 * KB, 400 * DAY],
      ]),
    },
    {
      // The eu-west-1 copy of the storefront assets (the replication rule above writes it).
      name: EU.s3Replica.name, region: EU.region, createdAt: now - 300 * DAY,
      settings: { tags: { Environment: "production", Purpose: "storefront static assets (eu replica)" }, blockPublic: ALL_BLOCKED, policyPublic: false, versioning: "Enabled", encryption: { algorithm: "AES256" } },
      objects: objs([["index.html", 3.2 * KB, 3 * DAY], ["static/app.3f9c2e1.js", 412 * KB, 3 * DAY], ["static/app.3f9c2e1.css", 58 * KB, 3 * DAY]]),
    },
    {
      // The data lake: Glue's scripts and temp files, Athena's results, the clickstream Firehose's deliveries.
      name: GLUE.lakeBucket, region: REGION, createdAt: now - 500 * DAY,
      settings: {
        tags: { Environment: "production", team: "data" }, blockPublic: ALL_BLOCKED, policyPublic: false, versioning: "Enabled",
        encryption: { algorithm: "aws:kms", kmsKey: KMS_KEYS.app.arn, bucketKey: true },
      },
      objects: objs([
        ["scripts/nightly_etl.py", 14 * KB, 30 * DAY], [`clickstream/${today}/part-0001.json.gz`, 48 * MB, 9 * MIN], [`clickstream/${yesterday}/part-0144.json.gz`, 51 * MB, DAY],
        [`athena-results/${today}/3f1e2d.csv`, 220 * KB, 2 * HOUR], ["tmp/.keep", 0, 400 * DAY],
      ]),
    },
  ];
  return new Map(buckets.map((b) => [b.name, b]));
}

const g = globalThis as { __edgeMockS3?: Map<string, MockBucket> };
const state = () => (g.__edgeMockS3 ??= seed());

function bucket(name: string): MockBucket {
  const b = state().get(name);
  if (!b) throw Object.assign(new Error("NoSuchBucket: The specified bucket does not exist"), { name: "NoSuchBucket" });
  return b;
}

export const mockS3: S3Api = {
  async buckets(_io, cap) {
    const all = [...state().values()].map(({ name, region, createdAt }) => ({ name, region, createdAt }));
    return { buckets: all.slice(0, cap), truncated: all.length > cap };
  },
  async settings(b) {
    const m = bucket(b.name);
    const times = [...m.objects.values()].map((o) => o.lastModified ?? 0);
    return { ...m.settings, lastActivityAt: times.length ? Math.max(...times) : undefined, unread: [], denied: [] };
  },
  async tags(b) {
    return { ...(bucket(b.name).settings.tags ?? {}) };
  },
  async objects(b, o): Promise<ObjectPage> {
    return listPage([...bucket(b.name).objects.values()], o);
  },
  async put(b, o) {
    const m = bucket(b.name);
    if (m.objects.has(o.key) && !o.overwrite) throw Object.assign(new Error("PreconditionFailed: an object with this key already exists (set overwrite to replace it)"), { name: "PreconditionFailed" });
    m.objects.set(o.key, { key: o.key, size: o.body.length, lastModified: Date.now(), storageClass: "STANDARD", contentType: o.contentType, body: o.body.length <= 256 * KB ? o.body : undefined });
    return { etag: `"${Date.now().toString(16)}"`, versionId: m.settings.versioning === "Enabled" ? `v${Date.now().toString(36)}` : undefined };
  },
  async remove(b, key) {
    const m = bucket(b.name);
    m.objects.delete(key);
    return m.settings.versioning === "Enabled" ? { deleteMarker: true, versionId: `dm${Date.now().toString(36)}` } : {};
  },
  async presign(b, key) {
    const o = bucket(b.name).objects.get(key);
    if (!o) throw Object.assign(new Error("NoSuchKey: The specified key does not exist."), { name: "NoSuchKey" });
    // No real bytes in the demo: a data: URL with the uploaded content, or a note standing in for it.
    const body = o.body ?? new TextEncoder().encode(`Simulated object s3://${b.name}/${key} (${o.size} bytes) — the demo account has no real data.\n`);
    return `data:${o.body ? (o.contentType ?? "application/octet-stream") : "text/plain"};base64,${Buffer.from(body).toString("base64")}`;
  },
};
