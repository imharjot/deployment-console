import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketResource, contentTypeError, decodeUpload, encryptionKey, humanBytes, listPage, locationRegion, MAX_UPLOAD_BYTES, notificationLinks, objectKeyError, prefixError,
  publicState, type BucketSettings,
} from "./edge-s3.ts";

const none: BucketSettings = { unread: [], denied: [] };
const blocked = { blockAcls: true, ignoreAcls: true, blockPolicy: true, restrict: true };

test("public state: Block Public Access wins, policy status decides, unknown stays unknown", () => {
  assert.equal(publicState(undefined), "unknown");
  assert.equal(publicState({ ...none, blockPublic: blocked, policyPublic: true }), "blocked");
  assert.equal(publicState({ ...none, policyPublic: true }), "public");
  assert.equal(publicState({ ...none, policyPublic: true, blockPublic: { ...blocked, blockAcls: false, restrict: true } }), "private");
  assert.equal(publicState({ ...none, policyPublic: false }), "private");
  assert.equal(publicState({ ...none }), "private"); // no policy at all
  assert.equal(publicState({ ...none, unread: ["policy status"] }), "unknown");
});

test("notifications → event links with filter evidence; EventBridge needs the account id", () => {
  const key = "arn:aws:s3:::acme-uploads";
  const links = notificationLinks(key, "us-east-1", [
    { type: "lambda", target: "arn:aws:lambda:us-east-1:1:function:thumb:live", events: ["s3:ObjectCreated:*"], prefix: "uploads/" },
    { type: "sqs", target: "arn:aws:sqs:us-east-1:1:q", events: ["s3:ObjectRemoved:*"], suffix: ".jpg" },
    { type: "eventbridge", events: [] },
  ], "123456789012");
  assert.deepEqual(links.map((l) => [l.to, l.kind, l.label, l.evidence]), [
    ["arn:aws:lambda:us-east-1:1:function:thumb", "event", "ObjectCreated:*", "s3:ObjectCreated:* prefix uploads/"],
    ["arn:aws:sqs:us-east-1:1:q", "event", "ObjectRemoved:*", "s3:ObjectRemoved:* suffix .jpg"],
    ["arn:aws:events:us-east-1:123456789012:event-bus/default", "event", undefined, "S3 → EventBridge (all bucket events)"],
  ]);
  assert.equal(notificationLinks(key, "us-east-1", [{ type: "eventbridge", events: [] }]).length, 0);
});

test("bucket → resource: keys, aliases, endpoints, links, warning when public without a website", () => {
  const { resource: r, links } = bucketResource({ name: "acme-uploads", region: "eu-west-1", createdAt: Date.UTC(2025, 0, 2) }, {
    ...none, tags: { Environment: "production" }, versioning: "Enabled", encryption: { algorithm: "aws:kms", kmsKey: "alias/aws/s3" },
    logging: { bucket: "acme-logs", prefix: "s3/" }, replication: [{ id: "dr", status: "Enabled", bucket: "arn:aws:s3:::acme-uploads-dr" }], policyPublic: true,
  });
  assert.equal(r.key, "arn:aws:s3:::acme-uploads");
  assert.deepEqual(r.aliases, ["acme-uploads", "s3://acme-uploads", "arn:aws:s3:::acme-uploads"]);
  assert.deepEqual(r.endpoints, ["acme-uploads.s3.eu-west-1.amazonaws.com", "acme-uploads.s3.amazonaws.com"]);
  assert.equal(r.health, "warning");
  assert.match(r.healthReason!, /public/);
  assert.equal(r.tags.Environment, "production");
  assert.ok(r.consoleUrl!.includes("region=eu-west-1"));
  // Without the account id a bare KMS alias can't become an ARN: no encrypts link (the prop still names it).
  assert.deepEqual(links.map((l) => [l.to, l.kind, l.label]), [
    ["arn:aws:s3:::acme-logs", "writes", "access logs"],
    ["arn:aws:s3:::acme-uploads-dr", "writes", "replication"],
  ]);
  // A public website is fine; its endpoint joins the endpoints; a redirect links to the target host.
  const site = bucketResource({ name: "acme.example", region: "us-east-1" }, { ...none, policyPublic: true, website: { redirectAll: "www.acme.example" } });
  assert.equal(site.resource.health, "ok");
  assert.ok(site.resource.endpoints!.includes("acme.example.s3-website-us-east-1.amazonaws.com"));
  assert.deepEqual(site.links.map((l) => [l.to, l.kind]), [["www.acme.example", "route"]]);
  // Settings not read → unknown, never idle-worthy guesses.
  const bare = bucketResource({ name: "x", region: "us-east-1" }, undefined);
  assert.equal(bare.resource.health, "unknown");
  assert.equal(bare.resource.lastActivityAt, undefined);
});

test("object keys, uploads, content types, prefixes", () => {
  assert.equal(objectKeyError("uploads/a.jpg"), undefined);
  assert.match(objectKeyError("")!, /required/);
  assert.match(objectKeyError("/a")!, /start/);
  assert.match(objectKeyError("a\nb")!, /control/);
  assert.match(objectKeyError("x".repeat(1025))!, /1,024/);
  const ok = decodeUpload(Buffer.from("hello").toString("base64"));
  assert.ok("bytes" in ok && ok.bytes.length === 5);
  assert.ok("error" in decodeUpload("not base64!"));
  assert.ok("error" in decodeUpload("data:text/plain;base64,aGk="));
  assert.ok("error" in decodeUpload("A".repeat(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4)));
  assert.equal(contentTypeError("image/png"), undefined);
  assert.equal(contentTypeError("text/plain; charset=utf-8"), undefined);
  assert.equal(contentTypeError(undefined), undefined);
  assert.ok(contentTypeError("<script>"));
  assert.equal(prefixError("uploads/"), undefined);
  assert.ok(prefixError("a\u0000"));
  assert.equal(locationRegion(null), "us-east-1");
  assert.equal(locationRegion("EU"), "eu-west-1");
  assert.equal(locationRegion("ap-south-1"), "ap-south-1");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(2.5 * 1024 * 1024), "2.5 MB");
});

test("listing with a delimiter: folders, objects, paging", () => {
  const all = ["index.html", "static/a.js", "static/b.js", "static/img/x.png", "z.txt"].map((key) => ({ key, size: 1 }));
  const top = listPage(all, { max: 100 });
  assert.deepEqual(top.prefixes, ["static/"]);
  assert.deepEqual(top.objects.map((o) => o.key), ["index.html", "z.txt"]);
  assert.equal(top.next, undefined);
  const inside = listPage(all, { prefix: "static/", max: 100 });
  assert.deepEqual([inside.prefixes, inside.objects.map((o) => o.key)], [["static/img/"], ["static/a.js", "static/b.js"]]);
  const p1 = listPage(all, { max: 2 });
  assert.equal(p1.next, "static/");
  const p2 = listPage(all, { max: 2, token: p1.next });
  assert.deepEqual(p2.objects.map((o) => o.key), ["z.txt"]);
  assert.equal(p2.next, undefined);
});

test("env files are never object actions: they belong to the Variables editor", async () => {
  const { objectKeyError } = await import("./edge-s3.ts");
  for (const k of ["staging/env/api.env", ".env", "config/.env.production", "x/.env-local", "API.ENV"]) assert.match(objectKeyError(k) ?? "", /Variables tab/, k);
  for (const k of ["assets/logo.png", "reports/environment.csv", "a/envoy.yaml"]) assert.equal(objectKeyError(k), undefined, k);
});

test("default encryption: the bucket's KMS key encrypts it (alias in the bucket's region, AWS-managed aws/s3 when none is named)", () => {
  const acct = "123456789012";
  const kms = (enc: BucketSettings["encryption"], region = "eu-west-1") =>
    bucketResource({ name: "b", region }, { ...none, tags: {}, encryption: enc }, acct).links.filter((l) => l.kind === "encrypts").map((l) => [l.from, l.to, l.label]);
  assert.deepEqual(kms({ algorithm: "aws:kms", kmsKey: "arn:aws:kms:eu-west-1:123456789012:key/k1" }), [["arn:aws:kms:eu-west-1:123456789012:key/k1", "arn:aws:s3:::b", "default encryption"]]);
  assert.deepEqual(kms({ algorithm: "aws:kms", kmsKey: "alias/acme" }), [["arn:aws:kms:eu-west-1:123456789012:alias/acme", "arn:aws:s3:::b", "default encryption"]]);
  assert.deepEqual(kms({ algorithm: "aws:kms" }), [["arn:aws:kms:eu-west-1:123456789012:alias/aws/s3", "arn:aws:s3:::b", "default encryption"]]);
  assert.deepEqual(kms({ algorithm: "aws:kms:dsse", kmsKey: "mrk-1" }, "us-east-1"), [["arn:aws:kms:us-east-1:123456789012:key/mrk-1", "arn:aws:s3:::b", "default encryption"]]);
  assert.deepEqual(kms({ algorithm: "AES256" }), [], "SSE-S3 uses no KMS key");
  assert.deepEqual(kms({ algorithm: "aws:kms", kmsKey: "mrk-1" }, "unknown"), [], "a bucket whose region is unknown can't name its key's region");
  assert.equal(encryptionKey(undefined, "us-east-1", acct), undefined);
});

test("R01/R18: tags not read are unread (never 'no tags'), and the per-bucket read state says why settings are missing", () => {
  const b = { name: "b", region: "us-east-1" };
  const listed = bucketResource(b, undefined).resource; // the checkpointed list: nothing read yet
  assert.deepEqual([listed.tagsUnread, listed.enrichment, listed.health], [true, undefined, "unknown"]);
  const late = bucketResource(b, undefined, "1", "skipped").resource;
  assert.deepEqual([late.tagsUnread, late.enrichment], [true, { settings: "skipped" }]);
  assert.match(late.healthReason!, /time budget/);
  assert.match(bucketResource(b, undefined, "1", "capped").resource.healthReason!, /more buckets than it reads/);
  assert.match(bucketResource(b, undefined, "1", "denied").resource.healthReason!, /permission denied/);
  // Settings read, but GetBucketTagging denied: the rest stands, tags stay unread.
  const denied = bucketResource(b, { ...none, unread: ["tags"], denied: ["s3:GetBucketTagging"], versioning: "Enabled" }, "1", "ok").resource;
  assert.deepEqual([denied.tagsUnread, denied.enrichment, denied.health], [true, { settings: "ok", tags: "denied" }, "ok"]);
  // NoSuchTagSet is an answer: no tags, read.
  const none_ = bucketResource(b, { ...none, tags: {} }, "1", "ok").resource;
  assert.deepEqual([none_.tagsUnread, none_.tags], [undefined, {}]);
});
