// Simulated EBS volumes, per region (the provider sets multiRegionMock), in the SDK's shapes so the real mapping runs
// (mock-names EBS). us-east-1: the staging ECS host's root volume (encrypted with the application key) and a 200 GiB
// build cache nobody has attached for months — a warning, billed per GB, and idle. Other regions: none.
import type { RawVolume } from "../../../inventory/ebs.ts";
import { EBS, KMS_KEYS, REGION } from "../mock-names.ts";

const DAY = 86_400_000;

export function simVolumes(region: string): RawVolume[] {
  if (region !== REGION) return [];
  return [
    {
      VolumeId: EBS.stagingRoot.id, Size: EBS.stagingRoot.sizeGb, VolumeType: "gp3", Iops: 3000, Throughput: 125, AvailabilityZone: `${REGION}a`, State: "in-use",
      CreateTime: new Date(Date.now() - 200 * DAY).toISOString(), Encrypted: true, KmsKeyId: KMS_KEYS.app.arn, SnapshotId: "snap-0acme0ecs0ami0001", MultiAttachEnabled: false,
      Attachments: [{ InstanceId: EBS.stagingRoot.instance, Device: "/dev/xvda", State: "attached", DeleteOnTermination: true }], Tags: [{ Key: "Name", Value: EBS.stagingRoot.name }],
    },
    {
      VolumeId: EBS.unattached.id, Size: EBS.unattached.sizeGb, VolumeType: "gp3", Iops: 3000, Throughput: 125, AvailabilityZone: `${REGION}b`, State: "available",
      CreateTime: new Date(Date.now() - 420 * DAY).toISOString(), Encrypted: false, MultiAttachEnabled: false, Attachments: [],
      Tags: [{ Key: "Name", Value: EBS.unattached.name }, { Key: "team", Value: "platform" }],
    },
  ];
}

// When each simulated volume was last read or written (simulated metrics aren't read): the root disk now, the cache
// not since it was detached.
export const simLastIo = (id: string): number | undefined => (id === EBS.stagingRoot.id ? Date.now() - 60_000 : id === EBS.unattached.id ? Date.now() - 140 * DAY : undefined);
