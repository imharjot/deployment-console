import { test } from "node:test";
import assert from "node:assert/strict";
import { ebsResults, volumeHealth, volumeResource, type RawVolume } from "./ebs.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_eb51";

// The real account's one volume (anonymised): the staging host's root disk, attached and unencrypted.
const root: RawVolume = {
  VolumeId: "vol-0root", Size: 16, VolumeType: "gp3", Iops: 3000, Throughput: 125, AvailabilityZone: "us-east-1a", State: "in-use", CreateTime: "2026-09-05T21:44:11.294Z",
  Encrypted: false, SnapshotId: "snap-0base", MultiAttachEnabled: false, Operator: { Managed: false },
  Attachments: [{ InstanceId: "i-0box", Device: "/dev/sda1", State: "attached", DeleteOnTermination: true }],
  ...({ FastRestored: false, SseType: SENTINEL, AvailabilityZoneId: SENTINEL } as object),
};

test("golden: an attached volume folds into its instance; nothing secret or unmapped leaks", () => {
  const { resource, links } = volumeResource(root, { region: R, accountId: ACCT, home: R, now: NOW });
  assert.deepEqual(resource, {
    key: `arn:aws:ec2:${R}:${ACCT}:volume/vol-0root`, kind: "ebs-volume", provider: "ebs", name: "vol-0root", region: R, tags: {}, health: "ok",
    props: [
      { label: "Volume id", value: "vol-0root", mono: true }, { label: "Type", value: "gp3" }, { label: "Size", value: "16 GiB" }, { label: "IOPS", value: "3000" },
      { label: "Throughput", value: "125 MiB/s" }, { label: "Availability zone", value: "us-east-1a" }, { label: "Attached to", value: "i-0box as /dev/sda1 (deleted with it)" },
      { label: "Encryption", value: "not encrypted" }, { label: "From snapshot", value: "snap-0base", mono: true },
    ],
    aliases: ["vol-0root"], parent: "ec2:i-0box", consoleUrl: `https://${R}.console.aws.amazon.com/ec2/home?region=${R}#VolumeDetails:volumeId=vol-0root`,
    createdAt: Date.parse("2026-09-05T21:44:11.294Z"), observedAt: NOW,
  });
  assert.deepEqual(links, []);
  assert.ok(!JSON.stringify(resource).includes(SENTINEL));
});

test("unattached volumes warn (billed per GB); KMS encrypts; region-aware parent; managed hidden volumes; deleted ones are gone", () => {
  const out = ebsResults([
    { VolumeId: "vol-old", Size: 200, VolumeType: "gp3", State: "available", Encrypted: true, KmsKeyId: "alias/aws/ebs", Tags: [{ Key: "Name", Value: "old-build-cache" }], Attachments: [] },
    { VolumeId: "vol-eu", State: "in-use", Encrypted: true, KmsKeyId: `arn:aws:kms:eu-west-1:${ACCT}:key/mrk-1`, Attachments: [{ InstanceId: "i-0eu", State: "attached" }] },
    { VolumeId: "vol-managed", State: "in-use", Operator: { Managed: true, Principal: "eks.amazonaws.com", HiddenByDefault: true }, Attachments: [{ InstanceId: "i-0node", State: "attached" }] },
    { VolumeId: "vol-gone", State: "deleted" },
  ], { region: "eu-west-1", accountId: ACCT, home: R });
  const [old, eu, managed] = out.resources;
  assert.equal(out.resources.length, 3);
  assert.deepEqual([old.name, old.health, old.healthReason, old.parent], ["old-build-cache", "warning", "unattached — billed per GB", undefined]);
  assert.deepEqual(out.links.map((l) => [l.from, l.to, l.kind]), [
    [`arn:aws:kms:eu-west-1:${ACCT}:alias/aws/ebs`, `arn:aws:ec2:eu-west-1:${ACCT}:volume/vol-old`, "encrypts"],
    [`arn:aws:kms:eu-west-1:${ACCT}:key/mrk-1`, `arn:aws:ec2:eu-west-1:${ACCT}:volume/vol-eu`, "encrypts"],
  ]);
  assert.equal(eu.parent, "ec2:i-0eu@eu-west-1");
  assert.deepEqual([managed.hidden, managed.props.find((p) => p.label === "Managed by")?.value], [true, "eks.amazonaws.com"]);
});

test("states: attaching warns, error is an error, deleting is stopped", () => {
  assert.deepEqual(volumeHealth({ State: "in-use", Attachments: [{ InstanceId: "i-1", State: "attaching" }] }), { health: "warning", healthReason: "attaching i-1" });
  assert.deepEqual(volumeHealth({ State: "error" }), { health: "error", healthReason: "the volume is in an error state" });
  assert.deepEqual(volumeHealth({ State: "deleting" }), { health: "stopped", healthReason: "deleting" });
  assert.deepEqual(volumeHealth({ State: "creating" }), { health: "warning", healthReason: "creating" });
});
