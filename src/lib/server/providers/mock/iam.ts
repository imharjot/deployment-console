// Simulated IAM roles of the Acme account (names from ../mock-names.ts), shaped like GetAccountAuthorizationDetails'
// RoleDetailList (trust policies URL-encoded, as the API returns them): the ECS task execution role, one task role per
// production service plus the console's own, the staging host's instance-profile role, the Lambda and CodeBuild roles,
// the EKS cluster role the EKS simulation names, the Step Functions and EventBridge roles of the checkout workflow, an
// AWS service-linked role (hidden), a deployer role nobody has used
// since it was created (never used → idle), and a partner role whose trust lets another account in without an external
// id (a warning). IAM is global: the same roles whatever region asks. Read-only (the provider has no actions).
import type { RawRole } from "../../../inventory/iam.ts";
import { ACCT, IAM_ROLES } from "../mock-names.ts";
import { DAY, HOUR } from "./serverless-sim.ts";

const trust = (principal: Record<string, unknown> | string, condition?: Record<string, unknown>) =>
  encodeURIComponent(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: principal, Action: "sts:AssumeRole", ...(condition ? { Condition: condition } : {}) }] }));
const service = (svc: string) => trust({ Service: svc });
const roleId = (n: number) => `AROA0ACME${String(n).padStart(11, "0")}`;
const managed = (...names: string[]) => names.map((n) => ({ PolicyName: n, PolicyArn: `arn:aws:iam::aws:policy/${n}` }));

export function simRoles(now: number = Date.now()): RawRole[] {
  const role = (def: { name: string; arn: string }, n: number, o: Partial<RawRole>): RawRole => ({
    Path: def.arn.slice(def.arn.indexOf(":role") + 5, def.arn.lastIndexOf("/") + 1) || "/",
    RoleName: def.name, RoleId: roleId(n), Arn: def.arn, CreateDate: new Date(now - 400 * DAY), MaxSessionDuration: 3600,
    Tags: [], InstanceProfileList: [], AttachedManagedPolicies: [], RolePolicyList: [], RoleLastUsed: { LastUsedDate: new Date(now - 2 * HOUR), Region: "us-east-1" },
    ...o,
  });
  const prod = [{ Key: "Environment", Value: "production" }];
  const task = (def: { name: string; arn: string }, n: number, inline: string) =>
    role(def, n, { AssumeRolePolicyDocument: service("ecs-tasks.amazonaws.com"), Tags: prod, RolePolicyList: [{ PolicyName: inline }], RoleLastUsed: { LastUsedDate: new Date(now - 20 * 60_000), Region: "us-east-1" } });
  return [
    role(IAM_ROLES.taskExecution, 1, { AssumeRolePolicyDocument: service("ecs-tasks.amazonaws.com"), AttachedManagedPolicies: managed("service-role/AmazonECSTaskExecutionRolePolicy"), RolePolicyList: [{ PolicyName: "read-variables" }], Description: "Pulls images and reads variables for every Acme task" }),
    task(IAM_ROLES.tasks.api, 2, "storefront-api-data"),
    task(IAM_ROLES.tasks.worker, 3, "jobs-queues"),
    task(IAM_ROLES.tasks.billing, 4, "billing-orders"),
    role(IAM_ROLES.tasks.console, 5, { AssumeRolePolicyDocument: service("ecs-tasks.amazonaws.com"), Tags: [{ Key: "console:self", Value: "true" }], RolePolicyList: [{ PolicyName: "deployment-console" }], Description: "The deployment console's own task role" }),
    role(IAM_ROLES.ecsInstance, 6, {
      AssumeRolePolicyDocument: service("ec2.amazonaws.com"), AttachedManagedPolicies: managed("service-role/AmazonEC2ContainerServiceforEC2Role", "AmazonSSMManagedInstanceCore"), Tags: [{ Key: "Environment", Value: "staging" }],
      InstanceProfileList: [{ InstanceProfileName: IAM_ROLES.ecsInstance.name, Arn: IAM_ROLES.ecsInstance.instanceProfile, Path: "/" }],
    }),
    role(IAM_ROLES.lambda, 7, { AssumeRolePolicyDocument: service("lambda.amazonaws.com"), AttachedManagedPolicies: managed("service-role/AWSLambdaBasicExecutionRole", "service-role/AWSLambdaSQSQueueExecutionRole"), RolePolicyList: [{ PolicyName: "shop-data" }] }),
    role(IAM_ROLES.codebuild, 8, { AssumeRolePolicyDocument: service("codebuild.amazonaws.com"), RolePolicyList: [{ PolicyName: "codebuild-base" }], RoleLastUsed: { LastUsedDate: new Date(now - 26 * HOUR), Region: "us-east-1" } }),
    role({ name: "acme-eks-cluster", arn: `arn:aws:iam::${ACCT}:role/acme-eks-cluster` }, 9, { AssumeRolePolicyDocument: service("eks.amazonaws.com"), AttachedManagedPolicies: managed("AmazonEKSClusterPolicy"), Tags: prod }),
    // The checkout workflow's role and the one EventBridge assumes to start it (the serverless simulations name them).
    role({ name: "acme-production-checkout-sfn", arn: `arn:aws:iam::${ACCT}:role/acme-production-checkout-sfn` }, 13, { AssumeRolePolicyDocument: service("states.amazonaws.com"), RolePolicyList: [{ PolicyName: "checkout-steps" }], Tags: prod }),
    role({ name: "acme-events-start-checkout", arn: `arn:aws:iam::${ACCT}:role/acme-events-start-checkout` }, 14, { AssumeRolePolicyDocument: service("events.amazonaws.com"), RolePolicyList: [{ PolicyName: "start-checkout" }], Tags: prod }),
    role(IAM_ROLES.serviceLinked, 10, { AssumeRolePolicyDocument: service("ecs.amazonaws.com"), AttachedManagedPolicies: managed("aws-service-role/AmazonECSServiceRolePolicy"), Description: "Role to enable Amazon ECS to manage your cluster." }),
    role(IAM_ROLES.neverUsed, 11, { AssumeRolePolicyDocument: trust({ AWS: `arn:aws:iam::${ACCT}:root` }), AttachedManagedPolicies: managed("PowerUserAccess"), CreateDate: new Date(now - 200 * DAY), RoleLastUsed: {}, Description: "Deploys from the old Jenkins box" }),
    role(IAM_ROLES.partner, 12, { AssumeRolePolicyDocument: trust({ AWS: `arn:aws:iam::${IAM_ROLES.partner.trustedAccount}:root` }), AttachedManagedPolicies: managed("ReadOnlyAccess"), MaxSessionDuration: 7200, RoleLastUsed: { LastUsedDate: new Date(now - 3 * DAY), Region: "us-east-1" }, Description: "Read-only access for the analytics partner" }),
  ];
}
