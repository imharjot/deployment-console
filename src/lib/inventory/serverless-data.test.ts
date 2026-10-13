import { test } from "node:test";
import assert from "node:assert/strict";
import { dynamoResult, kinesisResult } from "./serverless-data.ts";

test("DynamoDB: stream ARN is an alias, billing, health from table and index status", () => {
  const arn = "arn:aws:dynamodb:us-east-1:1:table/carts";
  const r = dynamoResult([
    {
      TableName: "carts", TableArn: arn, TableStatus: "ACTIVE", BillingModeSummary: { BillingMode: "PROVISIONED" }, ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 10 },
      ItemCount: 23870, TableSizeBytes: 9_800_000, LatestStreamArn: `${arn}/stream/2025`, StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
      KeySchema: [{ AttributeName: "cartId", KeyType: "HASH" }, { AttributeName: "itemId", KeyType: "RANGE" }], GlobalSecondaryIndexes: [{ IndexName: "by-customer", IndexStatus: "CREATING" }],
    },
    { TableName: "sessions", TableArn: "arn:aws:dynamodb:us-east-1:1:table/sessions", TableStatus: "INACCESSIBLE_ENCRYPTION_CREDENTIALS", BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" } },
  ]);
  const [carts, sessions] = r.resources;
  assert.deepEqual(carts.aliases, ["carts", `${arn}/stream/2025`]);
  assert.equal(carts.props.find((p) => p.label === "Billing")?.value, "Provisioned · 25 RCU · 10 WCU");
  assert.equal(carts.props.find((p) => p.label === "Key")?.value, "cartId (partition), itemId (sort)");
  assert.equal(carts.health, "warning"); // index backfilling
  assert.equal(sessions.health, "error");
  assert.equal(sessions.props.find((p) => p.label === "Billing")?.value, "On-demand");
});

test("Kinesis: mode, shards, consumers, status", () => {
  const r = kinesisResult([
    { StreamName: "clicks", StreamARN: "arn:aws:kinesis:us-east-1:1:stream/clicks", StreamStatus: "ACTIVE", StreamModeDetails: { StreamMode: "ON_DEMAND" }, OpenShardCount: 4, RetentionPeriodHours: 48, consumers: [{ ConsumerName: "recommender" }] },
    { StreamName: "old", StreamARN: "arn:aws:kinesis:us-east-1:1:stream/old", StreamStatus: "UPDATING", RetentionPeriodHours: 24 },
  ]);
  assert.equal(r.resources[0].props.find((p) => p.label === "Mode")?.value, "On-demand");
  assert.equal(r.resources[0].props.find((p) => p.label === "Retention")?.value, "2 days");
  assert.equal(r.resources[0].props.find((p) => p.label === "Enhanced fan-out consumers")?.value, "recommender");
  assert.equal(r.resources[1].health, "warning");
  assert.equal(r.resources[1].props.find((p) => p.label === "Retention")?.value, "24 h");
});

test("DynamoDB: details not read → unknown, never ok; tags not read → tagsUnread; its KMS key encrypts it", () => {
  const arn = "arn:aws:dynamodb:eu-west-1:123456789012:table/orders";
  const [listed] = dynamoResult([{ TableName: "orders", TableArn: arn, enrichment: { details: "capped", tags: "skipped" } }]).resources;
  assert.deepEqual([listed.health, listed.healthReason, listed.tagsUnread], ["unknown", "table details not read (capped)", true]);
  assert.equal(listed.props.find((p) => p.label === "Billing"), undefined, "nothing guessed");
  const read = dynamoResult([{ TableName: "orders", TableArn: arn, TableStatus: "ACTIVE", tags: {}, SSEDescription: { SSEType: "KMS", KMSMasterKeyArn: "arn:aws:kms:eu-west-1:123456789012:key/k-1" } }]);
  assert.deepEqual([read.resources[0].health, read.resources[0].tagsUnread], ["ok", undefined]);
  assert.deepEqual(read.links, [{ from: "arn:aws:kms:eu-west-1:123456789012:key/k-1", to: arn, kind: "encrypts", label: "items", evidence: "table encryption (SSEDescription.KMSMasterKeyArn)" }]);
});

test("Kinesis: a bare KMS alias becomes an alias ARN in the stream's region; tags not read → tagsUnread", () => {
  const arn = "arn:aws:kinesis:eu-west-1:123456789012:stream/clicks";
  const r = kinesisResult([{ StreamName: "clicks", StreamARN: arn, StreamStatus: "ACTIVE", EncryptionType: "KMS", KeyId: "alias/aws/kinesis", enrichment: { summary: "ok", tags: "denied" } }]);
  assert.deepEqual(r.links.map((l) => [l.kind, l.from, l.to]), [["encrypts", "arn:aws:kms:eu-west-1:123456789012:alias/aws/kinesis", arn]]);
  assert.deepEqual([r.resources[0].tagsUnread, r.resources[0].enrichment], [true, { summary: "ok", tags: "denied" }]);
  assert.equal(kinesisResult([{ StreamARN: arn }]).resources[0].health, "unknown", "no status reported: unknown");
});
