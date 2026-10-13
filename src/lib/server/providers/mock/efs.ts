// Simulated EFS of the Acme account (mock-names EFS), per region (the provider sets multiRegionMock), in the SDK's
// shapes so the real mapping runs. us-east-1: acme-production-media, encrypted with the application key, one mount
// target in each of production's private subnets (in the VPC's default security group), and the access point the
// production worker's task definition mounts (../../mock.ts: the ECS side draws that "mounts" link). Other regions: none.
import type { RawAccessPoint, RawFileSystem, RawMountTarget } from "../../../inventory/efs.ts";
import { ACCT, EFS, KMS_KEYS, NETWORK, REGION, SECURITY_GROUPS } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const fs = EFS.media;

function mountTargets(): RawMountTarget[] {
  return NETWORK.production.privateSubnets.map((subnet, i) => ({
    MountTargetId: `fsmt-0acme0media0000${i + 1}`, FileSystemId: fs.id, SubnetId: subnet, VpcId: NETWORK.production.vpc, LifeCycleState: "available",
    IpAddress: `10.20.${10 + i}.45`, AvailabilityZoneName: `${REGION}${"ab"[i]}`, NetworkInterfaceId: `eni-0acme0efs0mt000${i + 1}`,
    securityGroups: [SECURITY_GROUPS.defaults.production],
  }));
}

export function simFileSystems(region: string, now: number = Date.now()): RawFileSystem[] {
  if (region !== REGION) return [];
  return [{
    FileSystemId: fs.id, FileSystemArn: fs.arn, Name: fs.name, CreationTime: new Date(now - 260 * DAY), LifeCycleState: "available", NumberOfMountTargets: 2,
    SizeInBytes: { Value: 48 * 1024 ** 3, ValueInStandard: 12 * 1024 ** 3, ValueInIA: 36 * 1024 ** 3, ValueInArchive: 0 },
    PerformanceMode: "generalPurpose", ThroughputMode: "elastic", Encrypted: true, KmsKeyId: KMS_KEYS.app.arn,
    Tags: [{ Key: "Name", Value: fs.name }, { Key: "Environment", Value: "production" }], FileSystemProtection: { ReplicationOverwriteProtection: "ENABLED" },
    mountTargets: mountTargets(), enrichment: { "mount targets": "ok", "mount target security groups": "ok" },
    ...({ OwnerId: ACCT, CreationToken: "acme-media" } as object),
  }];
}

export function simAccessPoints(region: string): RawAccessPoint[] {
  if (region !== REGION) return [];
  return [{
    AccessPointId: fs.accessPoint.id, AccessPointArn: fs.accessPoint.arn, FileSystemId: fs.id, Name: "acme-media-worker", LifeCycleState: "available",
    RootDirectory: { Path: "/media" }, PosixUser: { Uid: 1000, Gid: 1000 }, Tags: [{ Key: "Name", Value: "acme-media-worker" }],
  }];
}

// The worker reads and writes media all day (simulated metrics aren't read).
export const simLastClient = (now: number = Date.now()) => now - 60_000;
