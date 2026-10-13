import { test } from "node:test";
import assert from "node:assert/strict";
import { accessDeniedOf, clip, errorBody, errText, flagAfterSend, HttpError, isOutcomeUnknown, NotConfiguredError, OutcomeUnknownError } from "./errors.ts";

const awsErr = (name: string, message: string) => Object.assign(new Error(message), { name });
const ROLE = "arn:aws:sts::123456789012:assumed-role/acme-console/i-0abc";

test("accessDeniedOf: every AWS spelling of access denied, with action and resource when named", () => {
  const ecs = awsErr("AccessDeniedException", `User: ${ROLE} is not authorized to perform: ecs:UpdateService on resource: arn:aws:ecs:eu-west-1:123456789012:service/acme-staging/api because no identity-based policy allows the ecs:UpdateService action`);
  assert.deepEqual(accessDeniedOf(ecs), { action: "ecs:UpdateService", resource: "arn:aws:ecs:eu-west-1:123456789012:service/acme-staging/api" });
  const ec2 = awsErr("UnauthorizedOperation", `You are not authorized to perform this operation. User: ${ROLE} is not authorized to perform: ec2:StopInstances on resource: arn:aws:ec2:eu-west-1:123456789012:instance/i-0123 with an explicit deny in an identity-based policy. Encoded authorization failure message: AbC`);
  assert.deepEqual(accessDeniedOf(ec2), { action: "ec2:StopInstances", resource: "arn:aws:ec2:eu-west-1:123456789012:instance/i-0123" });
  assert.deepEqual(accessDeniedOf(awsErr("AccessDenied", "Access Denied")), {});
  // Some services use another error name but the same message.
  assert.deepEqual(accessDeniedOf(awsErr("ClientException", `User: ${ROLE} is not authorized to perform: ssm:PutParameter`)), { action: "ssm:PutParameter" });
  assert.equal(accessDeniedOf(awsErr("ThrottlingException", "Rate exceeded")), undefined);
  assert.equal(accessDeniedOf("AccessDenied"), undefined);
  assert.equal(accessDeniedOf(null), undefined);
});

test("errText: access denied is friendly and never shows the principal ARN (F06/F37)", () => {
  const e = awsErr("AccessDeniedException", `User: ${ROLE} is not authorized to perform: ecs:UpdateService on resource: arn:aws:ecs:eu-west-1:123456789012:service/acme-staging/api because no identity-based policy allows it`);
  assert.equal(errText(e), "The console's AWS identity can't ecs:UpdateService on arn:aws:ecs:eu-west-1:123456789012:service/acme-staging/api");
  assert.equal(errText(awsErr("AccessDenied", "Access Denied")), "The console's AWS identity isn't allowed to do this");
  assert.ok(!errText(e).includes("assumed-role"));
  // Principal ARNs in any other error are redacted too.
  assert.equal(errText(awsErr("ValidationException", `${ROLE} cannot be used here`)), "ValidationException: <principal> cannot be used here");
  assert.ok(!errText(new Error("arn:aws:iam::123456789012:user/alice did something")).includes("alice"));
});

test("errText: the role a refusal is about stays visible; only the caller and the caller's own role are hidden", () => {
  // iam:PassRole names the role to pass as the resource: that is what the person has to grant.
  const pass = awsErr("AccessDeniedException", `User: ${ROLE} is not authorized to perform: iam:PassRole on resource: arn:aws:iam::123456789012:role/acme-api-task because no identity-based policy allows the iam:PassRole action`);
  assert.equal(errText(pass), "The console's AWS identity can't iam:PassRole on arn:aws:iam::123456789012:role/acme-api-task");
  // A refusal whose resource is the console's own role (SimulatePrincipalPolicy on itself) never shows it.
  const sim = awsErr("AccessDenied", `User: ${ROLE} is not authorized to perform: iam:SimulatePrincipalPolicy on resource: arn:aws:iam::123456789012:role/acme-console`);
  assert.equal(errText(sim), "The console's AWS identity can't iam:SimulatePrincipalPolicy on <principal>");
  // Other errors keep the role they are about.
  assert.equal(
    errText(awsErr("ClientException", "ECS was unable to assume the role 'arn:aws:iam::123456789012:role/acme-exec' that was provided for this task.")),
    "ClientException: ECS was unable to assume the role 'arn:aws:iam::123456789012:role/acme-exec' that was provided for this task.",
  );
});

test("errText: timeouts, names and non-errors as before", () => {
  assert.equal(errText(awsErr("TimeoutError", "x")), "timed out");
  assert.equal(errText(awsErr("AbortError", "x")), "timed out");
  assert.equal(errText(awsErr("ThrottlingException", "Rate exceeded")), "ThrottlingException: Rate exceeded");
  assert.equal(errText(new Error("plain")), "plain");
  assert.equal(errText("a string"), "a string");
  assert.equal(errText(new HttpError(404, "not found")), "not found");
});

test("errText cuts at a word boundary, at most 240 characters", () => {
  const long = `${"word ".repeat(80)}end`;
  const t = errText(new Error(long));
  assert.ok(t.length <= 240, `length ${t.length}`);
  assert.ok(t.endsWith("word…"), t.slice(-12));
  assert.equal(clip("short"), "short");
  // One very long token still gets cut (no boundary to use).
  assert.equal(clip("x".repeat(300)).length, 240);
});

test("NotConfiguredError: 503, code not_configured, optional setup", () => {
  const e = new NotConfiguredError("GitHub is not connected", "/docs/github");
  assert.ok(e instanceof HttpError);
  assert.equal(e.status, 503);
  assert.equal(e.code, "not_configured");
  assert.equal(e.setup, "/docs/github");
  assert.equal(e.message, "GitHub is not connected");
  assert.equal(new NotConfiguredError("x").setup, undefined);
});

test("isOutcomeUnknown: only when the request may have taken effect (F31)", () => {
  const u = new OutcomeUnknownError(undefined, { requestId: "req-1", cause: new Error("socket hang up") });
  assert.equal(u.name, "OutcomeUnknownError");
  assert.equal(u.status, 502);
  assert.equal(u.code, "outcome_unknown");
  assert.equal(u.requestId, "req-1");
  assert.match(u.message, /outcome unknown — check the resource before retrying/);
  assert.equal(isOutcomeUnknown(u), true);
  assert.equal(isOutcomeUnknown(awsErr("OutcomeUnknownError", "from another bundle")), true);
  assert.equal(isOutcomeUnknown(Object.assign(new Error("Jira: timed out"), { outcomeUnknown: true })), true, "the flag an integration call sets");
  // Aborts and timeouts only when flagged as after send.
  assert.equal(isOutcomeUnknown(awsErr("TimeoutError", "t")), false);
  assert.equal(isOutcomeUnknown(flagAfterSend(awsErr("TimeoutError", "t"))), true);
  assert.equal(isOutcomeUnknown(flagAfterSend(awsErr("AbortError", "a"))), true);
  // Socket resets: the request left, the answer didn't come back.
  assert.equal(isOutcomeUnknown(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
  assert.equal(isOutcomeUnknown(new Error("socket hang up")), true);
  assert.equal(isOutcomeUnknown(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })), true);
  // A refusal is a known outcome.
  assert.equal(isOutcomeUnknown(awsErr("AccessDeniedException", "no")), false);
  assert.equal(isOutcomeUnknown(new HttpError(409, "busy")), false);
  assert.equal(isOutcomeUnknown(undefined), false);
});

test("errorBody: code, setup and operationId reach the client only when set (C10)", () => {
  assert.deepEqual(errorBody(new HttpError(400, "env must be an environment id")), { error: "env must be an environment id" });
  assert.deepEqual(errorBody(new NotConfiguredError("GitHub isn't connected", "/docs/github")), { error: "GitHub isn't connected", code: "not_configured", setup: "/docs/github" });
  assert.deepEqual(errorBody(new NotConfiguredError("no CI repo")), { error: "no CI repo", code: "not_configured" });
  const unknown = new OutcomeUnknownError();
  unknown.operationId = "op_1";
  assert.deepEqual(errorBody(unknown), { error: "outcome unknown — check the resource before retrying", code: "outcome_unknown", operationId: "op_1" });
  // An OutcomeUnknownError's requestId stays server-side.
  assert.ok(!("requestId" in errorBody(new OutcomeUnknownError(undefined, { requestId: "r-1" }))));
});
