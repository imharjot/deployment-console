import { test } from "node:test";
import assert from "node:assert/strict";
import { efsDetail, efsHost, efsResult, fileSystemHealth, fileSystemResource, type RawAccessPoint, type RawFileSystem } from "./efs.ts";
import { infer } from "./infer.ts";
import type { Resource } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_efs1";

const fs: RawFileSystem = {
  FileSystemId: "fs-0media", FileSystemArn: `arn:aws:elasticfilesystem:${R}:${ACCT}:file-system/fs-0media`, Name: "media", CreationTime: "2026-01-02T03:04:05.000Z",
  LifeCycleState: "available", NumberOfMountTargets: 2, SizeInBytes: { Value: 6 * 1024 ** 3, ValueInStandard: 6 * 1024 ** 3 }, PerformanceMode: "generalPurpose",
  ThroughputMode: "provisioned", ProvisionedThroughputInMibps: 64, Encrypted: true, KmsKeyId: "alias/aws/elasticfilesystem", Tags: [{ Key: "Name", Value: "media" }, { Key: "Environment", Value: "production" }],
  mountTargets: [
    { MountTargetId: "fsmt-a", FileSystemId: "fs-0media", SubnetId: "subnet-a", VpcId: "vpc-prod", LifeCycleState: "available", IpAddress: "10.0.1.5", AvailabilityZoneName: "us-east-1a", securityGroups: ["sg-nfs"] },
    { MountTargetId: "fsmt-b", FileSystemId: "fs-0media", SubnetId: "subnet-b", VpcId: "vpc-prod", LifeCycleState: "available", IpAddress: "10.0.2.5", AvailabilityZoneName: "us-east-1b", securityGroups: ["sg-nfs", "sg-extra"] },
  ],
  enrichment: { "mount targets": "ok", "mount target security groups": "ok" },
  ...({ OwnerId: ACCT, CreationToken: SENTINEL } as object),
};
const aps: RawAccessPoint[] = [
  { AccessPointId: "fsap-1", AccessPointArn: `arn:aws:elasticfilesystem:${R}:${ACCT}:access-point/fsap-1`, FileSystemId: "fs-0media", Name: "worker", LifeCycleState: "available", RootDirectory: { Path: "/media" }, PosixUser: { Uid: 1000, Gid: 1000 }, ...({ ClientToken: SENTINEL } as object) },
  { AccessPointId: "fsap-other", FileSystemId: "fs-other", LifeCycleState: "available" },
];

test("golden: a file system — endpoint, mount targets' network, access points as aliases, KMS; nothing else leaks", () => {
  const { resource, links } = fileSystemResource(fs, aps, { region: R, account: ACCT, now: NOW });
  assert.deepEqual(resource, {
    key: `arn:aws:elasticfilesystem:${R}:${ACCT}:file-system/fs-0media`, kind: "efs-filesystem", provider: "efs", name: "media", region: R,
    tags: { Name: "media", Environment: "production" }, health: "ok",
    props: [
      { label: "File system id", value: "fs-0media", mono: true }, { label: "Size", value: "6 GB" }, { label: "Storage", value: "Regional" },
      { label: "Performance mode", value: "generalPurpose" }, { label: "Throughput", value: "provisioned · 64 MiB/s" }, { label: "Encryption", value: "KMS alias/aws/elasticfilesystem" },
      { label: "Mount targets", value: "2 · us-east-1a, us-east-1b" }, { label: "Access points", value: "worker" },
      { label: "Mount with", value: "fs-0media.efs.us-east-1.amazonaws.com", mono: true }, { label: "Created", value: "2026-01-02 03:04 UTC" },
    ],
    endpoints: ["fs-0media.efs.us-east-1.amazonaws.com", "us-east-1a.fs-0media.efs.us-east-1.amazonaws.com", "10.0.1.5", "us-east-1b.fs-0media.efs.us-east-1.amazonaws.com", "10.0.2.5"],
    aliases: ["fs-0media", `arn:aws:elasticfilesystem:${R}:${ACCT}:access-point/fsap-1`, "fsap-1"],
    vpcId: "vpc-prod", subnetIds: ["subnet-a", "subnet-b"], securityGroups: ["sg-nfs", "sg-extra"],
    enrichment: { "mount targets": "ok", "mount target security groups": "ok" },
    consoleUrl: `https://${R}.console.aws.amazon.com/efs/home?region=${R}#/file-systems/fs-0media`, createdAt: Date.parse("2026-01-02T03:04:05.000Z"), observedAt: NOW,
  });
  assert.deepEqual(links, [{ from: `arn:aws:kms:${R}:${ACCT}:alias/aws/elasticfilesystem`, to: resource.key, kind: "encrypts", label: "at rest", evidence: "EFS file system encryption key (KmsKeyId)" }]);
  const detail = efsDetail(resource.key, fs, aps, R);
  assert.deepEqual(detail.sections.map((s) => s.title), ["File system", "Mount targets", "Access points"]);
  assert.deepEqual(detail.sections[1].table?.rows[1], ["fsmt-b", "us-east-1b", "subnet-b", "10.0.2.5", "available", "sg-nfs, sg-extra"]);
  assert.deepEqual(detail.sections[2].table?.rows, [["fsap-1", "worker", "/media", "1000:1000", "available"]]);
  assert.ok(!JSON.stringify({ resource, links, detail }).includes(SENTINEL));
});

test("health: 0 mount targets warns; a mount target not available warns; states; mount targets unread fall back to the count", () => {
  assert.deepEqual(fileSystemHealth({ LifeCycleState: "available", NumberOfMountTargets: 0 }), { health: "warning", healthReason: "no mount targets — nothing can mount it" });
  assert.deepEqual(fileSystemHealth({ LifeCycleState: "available", NumberOfMountTargets: 2 }), { health: "ok" });
  assert.deepEqual(fileSystemHealth({ LifeCycleState: "available", mountTargets: [{ LifeCycleState: "creating", AvailabilityZoneName: "us-east-1c" }] }), { health: "warning", healthReason: "1 mount target creating (us-east-1c)" });
  assert.deepEqual(fileSystemHealth({ LifeCycleState: "available", NumberOfMountTargets: 3, mountTargets: [] }), { health: "warning", healthReason: "no mount targets — nothing can mount it" });
  assert.equal(fileSystemHealth({ LifeCycleState: "error" }).health, "error");
  assert.equal(fileSystemHealth({ LifeCycleState: "deleting" }).health, "stopped");
  assert.equal(fileSystemHealth({ LifeCycleState: "updating" }).health, "warning");

  const out = efsResult({
    fileSystems: [
      { FileSystemId: "fs-1", LifeCycleState: "available", NumberOfMountTargets: 0, AvailabilityZoneName: "us-east-1a", Encrypted: false, Tags: [], enrichment: { "mount targets": "denied" } },
      { FileSystemId: "fs-gone", LifeCycleState: "deleted" },
    ],
  }, { region: "cn-north-1", account: ACCT });
  assert.equal(out.resources.length, 1);
  const [one] = out.resources;
  assert.deepEqual([one.key, one.name, one.health, one.endpoints, one.enrichment, one.vpcId, out.links.length], [
    `arn:aws-cn:elasticfilesystem:cn-north-1:${ACCT}:file-system/fs-1`, "fs-1", "warning", ["fs-1.efs.cn-north-1.amazonaws.com.cn"], { "mount targets": "denied" }, undefined, 0,
  ]);
  assert.equal(one.props.find((p) => p.label === "Storage")?.value, "One Zone (us-east-1a)");
  assert.equal(efsDetail(one.key, { FileSystemId: "fs-1", enrichment: { "mount targets": "denied" } }, undefined, "cn-north-1").sections[1].note, "Mount targets not read (denied)");
  assert.equal(efsHost("fs-9", "eu-west-1"), "fs-9.efs.eu-west-1.amazonaws.com");
  assert.equal(efsDetail("k", undefined, undefined, R).sections[0].note, "This file system no longer exists.");
});

test("Resource Explorer's access-point rows fold into their file system (covered, never flagged as unmatched)", () => {
  const own = efsResult({ fileSystems: [fs], accessPoints: aps }, { region: R, account: ACCT });
  const row = (key: string, resourceType: string): Resource => ({ key, kind: "aws-resource", provider: "catchall", name: key, region: R, tags: {}, health: "unknown", props: [], resourceType, source: "resource-explorer" });
  const out = infer({
    results: [own, { resources: [row(aps[0].AccessPointArn!, "elasticfilesystem:access-point"), row(fs.FileSystemArn!, "elasticfilesystem:file-system")], links: [], mentions: [] }],
    providerOf: (i) => (i ? "catchall" : "efs"), home: R, accountId: ACCT, regions: [R], covered: new Set([`elasticfilesystem:access-point@${R}`, `elasticfilesystem:file-system@${R}`]),
  });
  assert.deepEqual(out.resources.filter((r) => r.kind === "aws-resource").length, 0);
  assert.deepEqual(out.notes.filter((n) => /key-format/.test(n)), []);
});
