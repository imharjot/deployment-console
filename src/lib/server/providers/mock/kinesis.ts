// Simulated Kinesis of the Acme account (names from ../mock-names.ts): the production clickstream, on-demand, encrypted
// with the application KMS key, read through enhanced fan-out by the EKS recommender (whose config mentions the
// stream). Only us-east-1 has it.
import type { RawStream } from "../../../inventory/serverless-data.ts";
import { KINESIS, KMS_KEYS, REGION } from "../mock-names.ts";
import { DAY, simState } from "./serverless-sim.ts";

function build(): RawStream[] {
  const now = Date.now();
  return [
    {
      StreamName: KINESIS.clickstream.name, StreamARN: KINESIS.clickstream.arn, StreamStatus: "ACTIVE", StreamModeDetails: { StreamMode: "ON_DEMAND" },
      RetentionPeriodHours: 48, StreamCreationTimestamp: new Date(now - 240 * DAY), EncryptionType: "KMS", KeyId: KMS_KEYS.app.alias, OpenShardCount: 4, ConsumerCount: 1,
      consumers: [{ ConsumerName: "recommender", ConsumerARN: `${KINESIS.clickstream.arn}/consumer/recommender:1719000000`, ConsumerStatus: "ACTIVE" }],
      tags: { Environment: "production", Team: "data" },
    },
  ];
}

const state = () => simState("__dcSimKinesis", build);

export const simKinesis = (region: string = REGION): RawStream[] =>
  region !== REGION ? [] : state().map((s) => ({ ...s, tags: { ...(s.tags ?? {}) }, consumers: s.consumers?.map((c) => ({ ...c })), lastActivityAt: Date.now() - 5_000 }));
