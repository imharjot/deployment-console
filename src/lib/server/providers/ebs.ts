// EBS volumes provider: every volume in the region (DescribeVolumes, 500 per page) with what it is attached to (its
// parent is the instance), its size, type and encryption key (encrypts link). An unattached volume is a warning: it is
// billed per GB whether anything uses it or not. Idle from read and write operations (both required, R20). Read-only.
// The mapping is pure (../../inventory/ebs.ts).
import "server-only";
import { DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { parseArn } from "../../inventory/arn.ts";
import { ebsResults } from "../../inventory/ebs.ts";
import { simLastIo, simVolumes } from "./mock/ebs.ts";
import { paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider } from "./types.ts";

const ec2 = perRegion((r) => new EC2Client(sdkConfig(r)), "ec2");

export const ebsProvider: Provider = {
  id: "ebs",
  label: "EBS volumes",
  kinds: ["ebs-volume"],
  scope: "regional",
  covers: ["ec2:volume"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["ec2:DescribeVolumes"],
  async discover(ctx) {
    const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
    if (ctx.mock) {
      const out = ebsResults(simVolumes(ctx.region), o);
      for (const r of out.resources) r.lastActivityAt = simLastIo(r.aliases?.[0] ?? "");
      return out;
    }
    const volumes = await paged(ctx, "ebs volumes", async (NextToken) => {
      const r = await ec2(ctx.region).send(new DescribeVolumesCommand({ MaxResults: 500, NextToken }), t(ctx));
      return { items: r.Volumes, next: r.NextToken };
    }, { service: "ec2" });
    return ebsResults(volumes, o);
  },
  // Not for hidden (service-managed) volumes: nobody looks at their idle marks (A.0 rule 10).
  activity: (r) => {
    if (r.hidden) return [];
    const VolumeId = parseArn(r.key)?.id ?? r.aliases?.[0] ?? "";
    const region = parseArn(r.key)?.region || undefined;
    return [
      { namespace: "AWS/EBS", metric: "VolumeReadOps", dims: { VolumeId }, stat: "Sum", label: "read operations", region, required: true },
      { namespace: "AWS/EBS", metric: "VolumeWriteOps", dims: { VolumeId }, stat: "Sum", label: "write operations", region, required: true },
    ];
  },
};
