// Simulated DynamoDB of the Acme account (names from ../mock-names.ts): production sessions (on-demand, read by the
// Storefront API and the public-api Lambda), carts (provisioned, with a stream and a by-customer index, written by the
// checkout step and the EKS feature store, encrypted with the application KMS key) and the staging sessions table.
// Only us-east-1 has tables.
import type { RawTable } from "../../../inventory/serverless-data.ts";
import { DYNAMO, KMS_KEYS, REGION } from "../mock-names.ts";
import { DAY, MIN, simState } from "./serverless-sim.ts";

function build(): (RawTable & { activeAgo: number })[] {
  const now = Date.now();
  const hashKey = (name: string) => [{ AttributeName: name, KeyType: "HASH" }];
  return [
    {
      TableName: DYNAMO.sessions.name, TableArn: DYNAMO.sessions.arn, TableStatus: "ACTIVE", BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
      ItemCount: 184_220, TableSizeBytes: 61_400_000, KeySchema: hashKey("sessionId"), DeletionProtectionEnabled: true, CreationDateTime: new Date(now - 420 * DAY),
      tags: { Environment: "production", Team: "shop" }, activeAgo: 10_000,
    },
    {
      TableName: DYNAMO.carts.name, TableArn: DYNAMO.carts.arn, TableStatus: "ACTIVE", BillingModeSummary: { BillingMode: "PROVISIONED" },
      ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 10 }, ItemCount: 23_870, TableSizeBytes: 9_800_000,
      KeySchema: [{ AttributeName: "cartId", KeyType: "HASH" }, { AttributeName: "itemId", KeyType: "RANGE" }],
      GlobalSecondaryIndexes: [{ IndexName: "by-customer", IndexStatus: "ACTIVE", ItemCount: 23_870 }],
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" }, LatestStreamArn: `${DYNAMO.carts.arn}/stream/2025-11-02T09:14:07.311`,
      DeletionProtectionEnabled: true, SSEDescription: { Status: "ENABLED", SSEType: "KMS", KMSMasterKeyArn: KMS_KEYS.app.arn }, CreationDateTime: new Date(now - 380 * DAY),
      tags: { Environment: "production", Team: "shop" }, activeAgo: 60_000,
    },
    {
      TableName: DYNAMO.sessionsStaging.name, TableArn: DYNAMO.sessionsStaging.arn, TableStatus: "ACTIVE", BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
      ItemCount: 312, TableSizeBytes: 96_000, KeySchema: hashKey("sessionId"), DeletionProtectionEnabled: false, CreationDateTime: new Date(now - 410 * DAY),
      tags: { Environment: "staging", Team: "shop" }, activeAgo: 3 * 60 * MIN,
    },
  ];
}

const state = () => simState("__dcSimDynamo", build);

export const simTable = (name: string) => state().find((t) => t.TableName === name);

export const simDynamo = (region: string = REGION): RawTable[] => {
  if (region !== REGION) return [];
  const now = Date.now();
  return state().map(({ activeAgo, ...t }) => ({ ...t, tags: { ...(t.tags ?? {}) }, lastActivityAt: now - activeAgo }));
};
