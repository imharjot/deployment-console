// Compute beyond ECS services: EC2 instances, Auto Scaling groups, EKS (clusters, nodegroups and — with Kubernetes
// read access — workloads), App Runner, Elastic Beanstalk, and the "Deploy image" action for ECS services.
import type { Provider } from "./types.ts";
import { apprunnerProvider } from "./apprunner.ts";
import { asgProvider } from "./asg.ts";
import { beanstalkProvider } from "./beanstalk.ts";
import { ec2Provider } from "./ec2.ts";
import { ecsImageProvider } from "./ecs-image.ts";
import { eksProvider } from "./eks.ts";

export const providers: Provider[] = [ec2Provider, asgProvider, eksProvider, apprunnerProvider, beanstalkProvider, ecsImageProvider];
