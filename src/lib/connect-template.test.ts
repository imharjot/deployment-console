import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CONNECT_ROLE_NAME, TEMPLATE_BODY_LIMIT, connectTemplate, trustedPrincipalOf } from "./connect-template.ts";
import { MANAGED_POLICY_LIMIT, SIMULATE_SID, type PolicyDocument, type Statement } from "./permissions.ts";

const readonly = async () => JSON.parse(await readFile(new URL("../../infra/iam-policy-readonly.json", import.meta.url), "utf8")) as PolicyDocument;
type Resource = { Type: string; Properties: Record<string, unknown> };
type Template = { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource>; Outputs: Record<string, unknown> };
const policies = (t: Template) => Object.entries(t.Resources).filter(([, r]) => r.Type === "AWS::IAM::ManagedPolicy");
const filled = { externalId: "dc-AbCdEfGhIjKlMnOpQrStUvWxYz012345", trusted: { account: "123456789012", type: "role" as const, name: "deployment-console-task" } };

test("trusted principal: a role from its session, a user under a path; not the root user or a federation session", () => {
  assert.deepEqual(trustedPrincipalOf("arn:aws:sts::123456789012:assumed-role/deployment-console-task/0f1e2d3c"), { account: "123456789012", type: "role", name: "deployment-console-task" });
  assert.deepEqual(trustedPrincipalOf("arn:aws:iam::123456789012:user/ops/alice"), { account: "123456789012", type: "user", name: "alice" });
  assert.match((trustedPrincipalOf("arn:aws:iam::123456789012:root") as { error: string }).error, /root user/);
  for (const arn of ["arn:aws:sts::123456789012:federated-user/bob", "not an arn"]) assert.ok("error" in trustedPrincipalOf(arn), arn);
});

test("connect template: a role only this console's login can switch into, and only with its external ID", async () => {
  const t = connectTemplate(await readonly(), filled) as unknown as Template;
  const role = t.Resources.Role.Properties as { RoleName: unknown; AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; ManagedPolicyArns: unknown[]; MaxSessionDuration: number };
  assert.equal(role.MaxSessionDuration, 3600);
  const [trust, ...more] = role.AssumeRolePolicyDocument.Statement;
  assert.equal(more.length, 0);
  assert.deepEqual(trust.Principal, { AWS: { "Fn::Sub": "arn:${AWS::Partition}:iam::${TrustedAccountId}:root" } });
  assert.equal(trust.Action, "sts:AssumeRole");
  assert.deepEqual(trust.Condition, {
    StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } },
    ArnLike: {
      "aws:PrincipalArn": [
        { "Fn::Sub": "arn:${AWS::Partition}:iam::${TrustedAccountId}:${TrustedPrincipalType}/${TrustedPrincipalName}" },
        { "Fn::Sub": "arn:${AWS::Partition}:iam::${TrustedAccountId}:${TrustedPrincipalType}/*/${TrustedPrincipalName}" },
      ],
    },
  });
  // The console's values are the defaults; the role name can be changed.
  assert.equal(t.Parameters.ExternalId.Default, filled.externalId);
  assert.equal(t.Parameters.TrustedAccountId.Default, "123456789012");
  assert.equal(t.Parameters.TrustedPrincipalType.Default, "role");
  assert.equal(t.Parameters.TrustedPrincipalName.Default, "deployment-console-task");
  assert.equal(t.Parameters.RoleName.Default, CONNECT_ROLE_NAME);
  for (const [name, p] of Object.entries(t.Parameters)) if (typeof p.AllowedPattern === "string" && typeof p.Default === "string") assert.match(p.Default, new RegExp(p.AllowedPattern), name);
  assert.ok(t.Outputs.RoleArn && t.Outputs.ExternalId);
  // The generic template asks for the console's values instead.
  const generic = connectTemplate(await readonly()) as unknown as Template;
  for (const name of ["ExternalId", "TrustedAccountId", "TrustedPrincipalType", "TrustedPrincipalName"]) assert.equal(generic.Parameters[name].Default, undefined, name);
});

test("connect template: the whole read-only policy, in parts AWS accepts, inline-sized", async () => {
  const doc = await readonly();
  const t = connectTemplate(doc, filled) as unknown as Template;
  const parts = policies(t);
  assert.ok(parts.length >= 1);
  const role = t.Resources.Role.Properties as { ManagedPolicyArns: { Ref: string }[] };
  assert.deepEqual(role.ManagedPolicyArns.map((a) => a.Ref), parts.map(([name]) => name));
  const actions = (sts: Statement[]) => sts.flatMap((s) => [s.Action ?? []].flat()).sort();
  const statements = parts.flatMap(([, r]) => (r.Properties.PolicyDocument as PolicyDocument).Statement);
  assert.deepEqual(actions(statements), actions(doc.Statement));
  for (const [name, r] of parts) {
    // Sized as IAM resolves it: the role's own ARN with the longest name the template allows.
    const resolved = JSON.stringify(r.Properties.PolicyDocument).replace(/\{"Fn::Sub":"[^"]*"\}/g, JSON.stringify(`arn:aws:iam::123456789012:role/${"r".repeat(64)}`));
    assert.ok(resolved.length <= MANAGED_POLICY_LIMIT, `${name}: ${resolved.length}`);
  }
  // The role simulates itself in Settings → AWS permissions.
  assert.deepEqual(statements.find((s) => s.Sid === SIMULATE_SID)?.Resource, { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${RoleName}" });
  assert.ok(Buffer.byteLength(JSON.stringify(t, null, 2) + "\n") <= TEMPLATE_BODY_LIMIT);
});

test("connect template: a placeholder a role in another account can't fill is refused, not shipped", async () => {
  const doc = await readonly();
  const withRegion = { ...doc, Statement: [...doc.Statement, { Effect: "Allow" as const, Action: "ecs:ListServices", Resource: "arn:aws:ecs:REGION:ACCOUNT_ID:service/*" }] };
  assert.throws(() => connectTemplate(withRegion), /placeholders .*REGION/);
});
