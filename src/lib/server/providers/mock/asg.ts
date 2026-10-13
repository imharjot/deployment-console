// Simulated Auto Scaling groups: the one behind EKS nodegroup "general" (its size follows the nodegroup) and the one
// Elastic Beanstalk made for the legacy admin — both owned by another service, so set-desired refuses them.
import type { AsgView } from "../../../inventory/compute-ec2.ts";
import { BEANSTALK, EKS } from "../mock-names.ts";
import { EB_ASG, EB_ASG_ARN, EB_INSTANCE, NODE_ASG, NODE_ASG_ARN, mockState } from "./compute-state.ts";

const lifecycle = (state: string) => (state === "running" ? "InService" : state === "pending" ? "Pending" : state === "shutting-down" ? "Terminating" : "Standby");

export function mockGroups(): AsgView[] {
  const s = mockState();
  const nodes = [...s.instances.values()].filter((i) => i.tags["aws:autoscaling:groupName"] === NODE_ASG);
  const eb = s.instances.get(EB_INSTANCE);
  return [
    {
      name: NODE_ASG, arn: NODE_ASG_ARN, min: s.nodegroup.min, max: s.nodegroup.max, desired: s.nodegroup.desired,
      instances: nodes.map((i) => ({ id: i.id, lifecycle: lifecycle(i.state), health: "Healthy", type: i.type, az: i.az })),
      launchTemplate: "eks-5ac9d2e1-3b4f-4c1a-9e1b-0a1b2c3d4e5f:3", instanceTypes: [EKS.nodegroup.instanceType], targetGroups: [], classicLbs: [],
      subnets: ["subnet-prod-a", "subnet-prod-b"], healthCheck: "EC2, grace 15 s", suspended: [],
      tags: {
        "eks:cluster-name": EKS.cluster.name, "eks:nodegroup-name": EKS.nodegroup.name, [`kubernetes.io/cluster/${EKS.cluster.name}`]: "owned",
        "k8s.io/cluster-autoscaler/enabled": "true",
      },
      createdAt: s.t0 - 200 * 86_400_000,
    },
    {
      name: EB_ASG, arn: EB_ASG_ARN, min: 1, max: 1, desired: 1,
      instances: eb ? [{ id: eb.id, lifecycle: lifecycle(eb.state), health: "Healthy", type: eb.type, az: eb.az }] : [],
      launchTemplate: `awseb-${BEANSTALK.env.id}-stack-AWSEBEC2LaunchTemplate-7G8H9I0J:4`, instanceTypes: ["t3.small"], targetGroups: [], classicLbs: [],
      subnets: ["subnet-prod-a"], healthCheck: "EC2, grace 0 s", suspended: [],
      tags: { "elasticbeanstalk:environment-name": BEANSTALK.env.name, "elasticbeanstalk:environment-id": BEANSTALK.env.id, "aws:cloudformation:stack-name": `awseb-${BEANSTALK.env.id}-stack` },
      createdAt: s.t0 - 700 * 86_400_000,
    },
  ];
}
