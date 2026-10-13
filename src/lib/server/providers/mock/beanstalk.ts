// Simulated Elastic Beanstalk: the old admin app (single instance, Elastic IP), health Yellow from 5xx responses, and
// environment properties that point at the production database.
import type { BeanstalkView, OptionSetting } from "../../../inventory/compute-paas.ts";
import { BEANSTALK, EXISTING, REGION } from "../mock-names.ts";
import { EB_ARN, EB_ASG, EB_EIP, EB_INSTANCE, EB_PLATFORM, EB_VERSIONS, mockState, type MEvent } from "./compute-state.ts";

const DB_HOST = `${EXISTING.rds.production}.c0example.${REGION}.rds.amazonaws.com`;
const ENV_NS = "aws:elasticbeanstalk:application:environment";
// Values are fake; they only ever reach the inventory as mentions.
const OPTIONS: OptionSetting[] = [
  { Namespace: "aws:ec2:vpc", OptionName: "VPCId", Value: EXISTING.vpc.production },
  { Namespace: "aws:ec2:vpc", OptionName: "Subnets", Value: EXISTING.subnets.production[0] },
  { Namespace: "aws:autoscaling:launchconfiguration", OptionName: "SecurityGroups", Value: "sg-prod-legacy-admin" },
  { Namespace: "aws:autoscaling:launchconfiguration", OptionName: "IamInstanceProfile", Value: "aws-elasticbeanstalk-ec2-role" },
  { Namespace: "aws:ec2:instances", OptionName: "InstanceTypes", Value: "t3.small" },
  { Namespace: "aws:elasticbeanstalk:environment", OptionName: "EnvironmentType", Value: "SingleInstance" },
  { Namespace: "aws:elasticbeanstalk:environment", OptionName: "ServiceRole", Value: "aws-elasticbeanstalk-service-role" },
  { Namespace: ENV_NS, OptionName: "NODE_ENV", Value: "production" },
  { Namespace: ENV_NS, OptionName: "DB_HOST", Value: DB_HOST },
  { Namespace: ENV_NS, OptionName: "DATABASE_URL", Value: `postgres://legacy_admin:fake-legacy-pass@${DB_HOST}:5432/admin` },
  { Namespace: ENV_NS, OptionName: "SESSION_SECRET", Value: "fake-session-secret-not-real" },
];

export function mockEnvironments(): BeanstalkView[] {
  const s = mockState();
  const eb = s.beanstalk;
  return [{
    name: BEANSTALK.env.name, id: BEANSTALK.env.id, arn: EB_ARN, app: BEANSTALK.app, status: eb.status, health: eb.status === "Ready" ? eb.health : "Grey",
    healthStatus: eb.healthStatus, cause: eb.cause, version: eb.version, platform: EB_PLATFORM, tier: "WebServer", cname: BEANSTALK.env.cname, endpointUrl: EB_EIP,
    tags: { Environment: "production", Owner: "back-office" }, createdAt: s.t0 - 700 * 86_400_000, updatedAt: eb.events[eb.events.length - 1]?.at,
    resources: { autoScalingGroups: [EB_ASG], instances: s.instances.has(EB_INSTANCE) ? [EB_INSTANCE] : [], loadBalancers: [], queues: [] },
    options: OPTIONS,
  }];
}

export function mockVersions() {
  const t0 = mockState().t0;
  return EB_VERSIONS.map((v) => ({ label: v.label, description: v.description, status: "PROCESSED", createdAt: t0 - v.ageDays * 86_400_000 }));
}

export const mockEvents = (): MEvent[] => [...mockState().beanstalk.events].sort((a, b) => b.at - a.at).slice(0, 20);
