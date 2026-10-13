// Simulated Data Firehose of the Acme account (names from ../mock-names.ts), as ListDeliveryStreams +
// DescribeDeliveryStream + ListTagsForDeliveryStream return it, per region. us-east-1: acme-clickstream-to-s3 reads the
// production clickstream (Kinesis) and lands it in the data lake bucket under clickstream/, compressed and encrypted
// with the application KMS key. Other regions: none. Read-only.
import type { RawDeliveryStream } from "../../../inventory/streaming.ts";
import { FIREHOSE, KINESIS, KMS_KEYS, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simFirehose(region: string, now: number = Date.now()): RawDeliveryStream[] {
  if (region !== REGION) return [];
  const f = FIREHOSE.clickstream;
  return [
    {
      DeliveryStreamName: f.name, DeliveryStreamARN: f.arn, DeliveryStreamStatus: "ACTIVE", DeliveryStreamType: "KinesisStreamAsSource",
      CreateTimestamp: new Date(now - 180 * DAY), LastUpdateTimestamp: new Date(now - 30 * DAY),
      DeliveryStreamEncryptionConfiguration: { Status: "DISABLED" }, // a Kinesis-sourced stream relies on the source stream's encryption
      Source: { KinesisStreamSourceDescription: { KinesisStreamARN: KINESIS.clickstream.arn } },
      Destinations: [{
        DestinationId: "destinationId-000000000001",
        ExtendedS3DestinationDescription: {
          BucketARN: `arn:aws:s3:::${f.bucket}`, Prefix: "clickstream/!{timestamp:yyyy/MM/dd}/",
          EncryptionConfiguration: { KMSEncryptionConfig: { AWSKMSKeyARN: KMS_KEYS.app.arn } },
          CloudWatchLoggingOptions: { Enabled: false }, ProcessingConfiguration: { Enabled: false, Processors: [] }, S3BackupMode: "Disabled",
        },
      }],
      HasMoreDestinations: false,
      tags: [{ Key: "Environment", Value: "production" }, { Key: "Team", Value: "data" }],
      enrichment: { describe: "ok", tags: "ok" },
    },
  ];
}
