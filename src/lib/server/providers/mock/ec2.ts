// Simulated EC2 instances (the bastion, the stopped legacy cron box, the EKS nodes and the Beanstalk instance) as the
// real provider's InstanceView, so both paths share one mapping. The staging ECS host comes from ../../mock.ts via
// discovery, like a real ECS container instance.
import type { InstanceView } from "../../../inventory/compute-ec2.ts";
import { EXISTING } from "../mock-names.ts";
import { mockState } from "./compute-state.ts";

export function mockInstances(): InstanceView[] {
  const now = Date.now();
  return [...mockState().instances.values()].map((i) => ({
    id: i.id, type: i.type, state: i.state, reason: i.state === "stopped" ? i.reason : undefined, launchedAt: i.launchedAt,
    privateIp: i.privateIp, privateDns: `ip-${i.privateIp.replaceAll(".", "-")}.ec2.internal`,
    publicIp: i.state === "running" ? (i.eip ?? i.publicIp) : i.eip, elasticIps: i.eip ? [i.eip] : [],
    vpcId: i.vpcId, subnetId: i.subnetId, securityGroups: i.sgs, profileArn: i.profile, platform: i.platform, imageId: i.ami, az: i.az,
    tags: i.tags, checks: i.state === "running" ? { system: "ok", instance: "ok" } : undefined, rebooting: !!i.rebootUntil && now < i.rebootUntil,
  }));
}

// The ECS hosts' instance profiles (../../mock.ts's RawBox doesn't carry one; a real DescribeInstances does).
export const mockHostProfile = (id: string): string | undefined => (id === EXISTING.stagingBox.id ? EXISTING.stagingBox.instanceProfile : undefined);
