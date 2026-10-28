// The CloudFormation template that connects an AWS account to this console without keys (Settings → AWS connection →
// Switch into a role → Create it with CloudFormation). It makes a role holding the console's read-only policy that
// only the console's own login can switch into, and only with the console's external ID. Monitoring and security
// products reach their customers' accounts the same way: no keys change hands, each session lasts an hour, every use
// shows in the account's CloudTrail, and deleting the stack cuts the console off.
// Pure: scripts/iam-policy.mjs writes the generic template (infra/connect-aws-role.json, checked in CI), and
// GET /api/connection/template serves it with this console's values filled in (src/lib/server/connection.ts).
import { roleArnFromCaller } from "./capability-rules.ts";
import { MANAGED_POLICY_LIMIT, placeholdersIn, SIMULATE_SID, splitPolicy, type PolicyDocument, type Statement } from "./permissions.ts";

export const CONNECT_ROLE_NAME = "deployment-console-access";
export const CONNECT_STACK_NAME = "deployment-console-access";
// What CloudFormation takes without an S3 bucket: `aws cloudformation deploy --template-file`.
export const TEMPLATE_BODY_LIMIT = 51_200;
// Each part leaves room for the role's own ARN, which replaces the shorter placeholder in SimulateOwnPermissions.
const PART_LIMIT = MANAGED_POLICY_LIMIT - 128;

// The console's own login as the role's trust policy names it: an IAM role (an ECS task role, an EC2 instance
// profile's role, a role behind a profile) or an IAM user. The name is enough, since the trust policy matches it under
// any path (a session's ARN doesn't show the role's path).
export interface TrustedPrincipal {
  account: string;
  type: "role" | "user";
  name: string;
}

// From sts:GetCallerIdentity's ARN. The root user and federation-token sessions can't switch into roles at all.
export function trustedPrincipalOf(callerArn: string): TrustedPrincipal | { error: string } {
  const m = /^arn:aws[a-z-]*:iam::(\d{12}):(role|user)\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]{1,128})$/.exec(roleArnFromCaller(callerArn));
  if (m) return { account: m[1], type: m[2] as TrustedPrincipal["type"], name: m[3] };
  if (/^arn:aws[a-z-]*:iam::\d{12}:root$/.test(callerArn))
    return { error: "This console signs in as the account's root user, and AWS doesn't let the root user switch into roles. Give the console an IAM user or role of its own first." };
  return { error: `This console's own login (${callerArn}) can't switch into roles. Give the console an IAM user or role of its own first.` };
}

const sub = (s: string) => ({ "Fn::Sub": s });
const trustedArn = (path: string) => sub("arn:${AWS::Partition}:iam::${TrustedAccountId}:${TrustedPrincipalType}/" + path + "${TrustedPrincipalName}");

// `readonly`: infra/iam-policy-readonly.json. Without `fill` the parameters ask for the console's values.
export function connectTemplate(readonly: PolicyDocument, fill: { externalId?: string; trusted?: TrustedPrincipal } = {}): Record<string, unknown> {
  const left = placeholdersIn({ ...readonly, Statement: readonly.Statement.filter((s) => s.Sid !== SIMULATE_SID) });
  if (left.length) throw new Error(`the read-only policy has placeholders a role in another account can't fill: ${left.join(", ")}`);
  // Settings → AWS permissions simulates the console's own identity, which is this role once the console switches in.
  const self = (s: Statement) => (s.Sid === SIMULATE_SID && s.Effect === "Allow" ? { ...s, Resource: sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${RoleName}") } : s);
  const parts = splitPolicy(readonly, PART_LIMIT).map((p) => ({ ...p, Statement: p.Statement.map(self) }));
  const named = (i: number) => `ReadOnlyPolicy${i + 1}`;
  const param = (p: Record<string, unknown>, value: string | undefined) => (value === undefined ? p : { ...p, Default: value });
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description:
      "Lets one Deployment Console read this AWS account: a read-only IAM role that only that console's own login can switch into, and only with its external ID. No keys are created. Delete this stack to cut the console off.",
    Metadata: {
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          { Label: { default: "The console that may connect (filled in by the console)" }, Parameters: ["TrustedAccountId", "TrustedPrincipalType", "TrustedPrincipalName", "ExternalId"] },
          { Label: { default: "The role this stack creates" }, Parameters: ["RoleName"] },
        ],
        ParameterLabels: {
          TrustedAccountId: { default: "Console's AWS account" },
          TrustedPrincipalType: { default: "Console's login is a" },
          TrustedPrincipalName: { default: "Console's login name" },
          ExternalId: { default: "External ID" },
          RoleName: { default: "Role name" },
        },
      },
    },
    Parameters: {
      TrustedAccountId: param({ Type: "String", AllowedPattern: "^\\d{12}$", ConstraintDescription: "a 12-digit AWS account ID", Description: "The AWS account the console runs in." }, fill.trusted?.account),
      TrustedPrincipalType: param({ Type: "String", AllowedValues: ["role", "user"], Description: "Whether the console's own login is an IAM role (ECS task role, EC2 instance profile) or an IAM user." }, fill.trusted?.type),
      TrustedPrincipalName: param({ Type: "String", AllowedPattern: "^[\\w+=,.@-]{1,128}$", ConstraintDescription: "an IAM role or user name, without its path", Description: "The name of that role or user, without its path." }, fill.trusted?.name),
      ExternalId: param({ Type: "String", AllowedPattern: "^[\\w+=,.@:/-]{2,1224}$", ConstraintDescription: "2 to 1224 letters, digits or +=,.@:/-", Description: "The console's external ID: the role can only be switched into with it." }, fill.externalId),
      RoleName: { Type: "String", Default: CONNECT_ROLE_NAME, AllowedPattern: "^[\\w+=,.@-]{1,64}$", ConstraintDescription: "1 to 64 letters, digits or +=,.@_-", Description: "The name of the role to create." },
    },
    Resources: {
      ...Object.fromEntries(
        parts.map((PolicyDocument, i) => [named(i), { Type: "AWS::IAM::ManagedPolicy", Properties: { Description: `Deployment Console read-only access${parts.length > 1 ? `, part ${i + 1} of ${parts.length}` : ""}`, PolicyDocument } }]),
      ),
      Role: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: { Ref: "RoleName" },
          Description: "Read-only access for one Deployment Console. Delete the stack that made it to cut the console off.",
          MaxSessionDuration: 3600,
          // The console's account as principal, narrowed to its login by aws:PrincipalArn: unlike naming the role or user
          // as principal, this holds when the login sits under an IAM path or is deleted and made again.
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "OnlyThisConsole",
                Effect: "Allow",
                Principal: { AWS: sub("arn:${AWS::Partition}:iam::${TrustedAccountId}:root") },
                Action: "sts:AssumeRole",
                Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } }, ArnLike: { "aws:PrincipalArn": [trustedArn(""), trustedArn("*/")] } },
              },
            ],
          },
          ManagedPolicyArns: parts.map((_, i) => ({ Ref: named(i) })),
          Tags: [{ Key: "created-by", Value: "deployment-console" }],
        },
      },
    },
    Outputs: {
      RoleArn: { Description: "Paste this into the console: Settings, AWS connection, Switch into a role.", Value: { "Fn::GetAtt": ["Role", "Arn"] } },
      ExternalId: { Description: "The external ID the role expects.", Value: { Ref: "ExternalId" } },
    },
  };
}
