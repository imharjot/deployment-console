// Simulated KMS keys of the Acme account (names from ../mock-names.ts), as ListKeys + ListAliases + DescribeKey (+ rotation
// and tags for customer keys) would return them, per region. us-east-1: the application key (multi-Region primary,
// rotated yearly; it encrypts the production database, the cache, queues, tables and buckets), the legacy backups key
// scheduled for deletion in 5 days (it still encrypts acme-old-backups: R2 warns the bucket), and three AWS-managed keys
// (hidden) that services use by default. eu-west-1: the application key's replica. Other regions: none. Read-only.
import type { RawKmsKey } from "../../../inventory/kms.ts";
import { EU_REGION, KMS_KEYS, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

// AWS-managed key ids (mock-names gives their alias ARNs; the ids are this simulation's).
const MANAGED: [alias: string, id: string][] = [
  ["alias/aws/rds", "0acme0aw-0000-4000-8000-000000000001"],
  ["alias/aws/secretsmanager", "0acme0aw-0000-4000-8000-000000000002"],
  ["alias/aws/sqs", "0acme0aw-0000-4000-8000-000000000003"],
];
const keyArn = (region: string, id: string) => KMS_KEYS.app.arn.replace(`:${REGION}:`, `:${region}:`).replace(KMS_KEYS.app.id, id);

export function simKms(region: string, now: number = Date.now()): RawKmsKey[] {
  const ok = { describe: "ok", rotation: "ok", tags: "ok" } as const;
  if (region === EU_REGION)
    return [
      {
        KeyId: KMS_KEYS.appReplica.id, KeyArn: KMS_KEYS.appReplica.arn, aliases: [KMS_KEYS.app.alias], enrichment: ok,
        metadata: {
          KeyId: KMS_KEYS.appReplica.id, Arn: KMS_KEYS.appReplica.arn, KeyManager: "CUSTOMER", KeyState: "Enabled", KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT",
          Origin: "AWS_KMS", MultiRegion: true, MultiRegionConfiguration: { MultiRegionKeyType: "REPLICA", PrimaryKey: { Arn: KMS_KEYS.app.arn, Region: REGION } },
          Description: "Acme application data (replica)", CreationDate: new Date(now - 120 * DAY),
        },
        rotation: { KeyRotationEnabled: true, RotationPeriodInDays: 365, NextRotationDate: new Date(now + 60 * DAY) },
        tags: [{ TagKey: "Environment", TagValue: "production" }],
      },
    ];
  if (region !== REGION) return [];
  return [
    {
      KeyId: KMS_KEYS.app.id, KeyArn: KMS_KEYS.app.arn, aliases: [KMS_KEYS.app.alias], enrichment: ok,
      metadata: {
        KeyId: KMS_KEYS.app.id, Arn: KMS_KEYS.app.arn, KeyManager: "CUSTOMER", KeyState: "Enabled", KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT", Origin: "AWS_KMS",
        MultiRegion: true, MultiRegionConfiguration: { MultiRegionKeyType: "PRIMARY", PrimaryKey: { Arn: KMS_KEYS.app.arn, Region: REGION }, ReplicaKeys: [{ Arn: KMS_KEYS.appReplica.arn, Region: EU_REGION }] },
        Description: "Acme application data", CreationDate: new Date(now - 500 * DAY),
      },
      rotation: { KeyRotationEnabled: true, RotationPeriodInDays: 365, NextRotationDate: new Date(now + 60 * DAY) },
      tags: [{ TagKey: "Environment", TagValue: "production" }, { TagKey: "Team", TagValue: "platform" }],
    },
    {
      KeyId: KMS_KEYS.legacy.id, KeyArn: KMS_KEYS.legacy.arn, aliases: [KMS_KEYS.legacy.alias], enrichment: { describe: "ok", tags: "ok" },
      metadata: {
        KeyId: KMS_KEYS.legacy.id, Arn: KMS_KEYS.legacy.arn, KeyManager: "CUSTOMER", KeyState: "PendingDeletion", KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT", Origin: "AWS_KMS",
        MultiRegion: false, DeletionDate: new Date(now + KMS_KEYS.legacy.deletionInDays * DAY), PendingDeletionWindowInDays: 7, Description: "Old backups (retired)", CreationDate: new Date(now - 1400 * DAY),
      },
      tags: [],
    },
    ...MANAGED.map(([alias, id]): RawKmsKey => ({
      KeyId: id, KeyArn: keyArn(REGION, id), aliases: [alias], enrichment: { describe: "ok" },
      metadata: {
        KeyId: id, Arn: keyArn(REGION, id), KeyManager: "AWS", KeyState: "Enabled", KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT", Origin: "AWS_KMS", MultiRegion: false,
        Description: `Default key that protects my ${alias.split("/").pop()} data when no other key is defined`, CreationDate: new Date(now - 700 * DAY),
      },
    })),
  ];
}
