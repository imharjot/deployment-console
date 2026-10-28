import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credentialsSection, describeArn, describeSignIn, lockedConflicts, parseConnectionInput, parseNewProfile, parseSaved, profileKinds, profileNames, resolveConnection, roleArnProblem, scopeKey, signInFailure, staleWrite, suggestHome, withInput, type SavedConnection,
} from "./connection-rules.ts";

const saved = (s: Partial<SavedConnection> = {}): SavedConnection => ({ source: "aws", rev: 1, by: "admin@example.com", at: 1, ...s });

test("connection: an environment variable that is set decides its part, then Settings, then the simulated account", () => {
  const none = resolveConnection({});
  assert.equal(none.source, "mock");
  assert.deepEqual(none.signIn, { kind: "chain" });
  assert.equal(none.home, "us-east-1");
  assert.deepEqual(none.from, { source: "default", signIn: "default", home: "default" });
  assert.deepEqual(none.locked, {});

  const fromSettings = resolveConnection({}, saved({ signIn: { kind: "profile", profile: "console-readonly" }, home: "eu-west-1", regions: ["us-east-1"] }));
  assert.equal(fromSettings.source, "aws");
  assert.deepEqual(fromSettings.signIn, { kind: "profile", profile: "console-readonly" });
  assert.equal(fromSettings.home, "eu-west-1");
  assert.deepEqual(fromSettings.regions, ["us-east-1"]);
  assert.deepEqual(fromSettings.from, { source: "settings", signIn: "settings", home: "settings" });

  const env = { CONSOLE_SOURCE: "mock", AWS_REGION: "ap-south-1", AWS_PROFILE: "ops", CONSOLE_REGIONS: "all-enabled" };
  const pinned = resolveConnection(env, saved({ signIn: { kind: "chain" }, home: "eu-west-1" }));
  assert.equal(pinned.source, "mock");
  assert.equal(pinned.home, "ap-south-1");
  assert.deepEqual(pinned.signIn, { kind: "profile", profile: "ops" });
  assert.deepEqual(pinned.locked, { source: "CONSOLE_SOURCE", signIn: "AWS_PROFILE", home: "AWS_REGION", regions: "CONSOLE_REGIONS" });
  assert.deepEqual(pinned.from, { source: "env", signIn: "env", home: "env" });

  // Empty counts as unset; AWS_DEFAULT_REGION stands in for AWS_REGION; keys in the environment pin the sign-in.
  const empty = resolveConnection({ CONSOLE_SOURCE: " ", AWS_REGION: "", AWS_DEFAULT_REGION: "eu-central-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE" }, saved({ signIn: { kind: "profile", profile: "x" } }));
  assert.equal(empty.source, "aws");
  assert.equal(empty.home, "eu-central-1");
  assert.equal(empty.locked.home, "AWS_DEFAULT_REGION");
  assert.deepEqual(empty.signIn, { kind: "chain" });
  assert.equal(empty.locked.signIn, "AWS_ACCESS_KEY_ID");
  assert.throws(() => resolveConnection({ CONSOLE_SOURCE: "prod" }), /CONSOLE_SOURCE must be "aws" or "mock"/);
  // A deployment pinning CONSOLE_SOURCE=aws signs in as its environment says (a task role): Settings picks no identity.
  const deployed = resolveConnection({ CONSOLE_SOURCE: "aws" }, saved({ signIn: { kind: "role", roleArn: "arn:aws:iam::123456789012:role/r" }, home: "eu-west-1" }));
  assert.deepEqual(deployed.signIn, { kind: "chain" });
  assert.equal(deployed.locked.signIn, "CONSOLE_SOURCE");
  assert.equal(deployed.home, "eu-west-1", "the home region is still Settings' to choose");
});

test("connection: a save may not change what the environment decides", () => {
  const current = resolveConnection({ CONSOLE_SOURCE: "aws", AWS_REGION: "ap-south-1" });
  assert.deepEqual(lockedConflicts(current, { source: "mock" }), ["CONSOLE_SOURCE"]);
  assert.deepEqual(lockedConflicts(current, { source: "aws", home: "eu-west-1" }), ["AWS_REGION"]);
  assert.deepEqual(lockedConflicts(current, { source: "aws", home: "ap-south-1" }), []);
  assert.deepEqual(lockedConflicts(current, { source: "aws", signIn: { kind: "profile", profile: "a" } }), ["CONSOLE_SOURCE"], "pinned to AWS: so is the sign-in");
  assert.deepEqual(lockedConflicts(resolveConnection({ CONSOLE_REGIONS: "us-east-1" }), { source: "aws", regions: ["eu-west-1"] }), ["CONSOLE_REGIONS"]);
  assert.equal(withInput({ AWS_REGION: "ap-south-1" }, { source: "aws", home: "eu-west-1" }).home, "ap-south-1");
});

test("connection input: profiles must exist, roles must be role ARNs, regions must be region codes, and no keys", () => {
  const profiles = ["default", "console-readonly"];
  assert.deepEqual(parseConnectionInput({ source: "mock", signIn: { kind: "role" } }), { ok: true, value: { source: "mock" } });
  assert.deepEqual(parseConnectionInput({ source: "aws", signIn: { kind: "profile", profile: "console-readonly" }, home: " AP-SOUTH-1 ", regions: ["us-east-1", "us-east-1"] }, profiles), {
    ok: true,
    value: { source: "aws", signIn: { kind: "profile", profile: "console-readonly" }, home: "ap-south-1", regions: ["us-east-1"] },
  });
  assert.match((parseConnectionInput({ source: "aws", signIn: { kind: "profile", profile: "nope" } }, profiles) as { error: string }).error, /no profile "nope"/);
  assert.deepEqual(parseConnectionInput({ source: "aws", signIn: { kind: "role", roleArn: "arn:aws:iam::123456789012:role/console-readonly", externalId: "acme-ops" } }), {
    ok: true,
    value: { source: "aws", signIn: { kind: "role", roleArn: "arn:aws:iam::123456789012:role/console-readonly", externalId: "acme-ops" } },
  });
  for (const bad of [
    { source: "prod" },
    { source: "aws", signIn: { kind: "keys", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "x" } },
    { source: "aws", signIn: { kind: "role", roleArn: "arn:aws:iam::123456789012:user/me" } },
    { source: "aws", signIn: { kind: "role", roleArn: "arn:aws:iam::123456789012:role/r", externalId: "x" } },
    { source: "aws", home: "europe" },
    { source: "aws", regions: ["us-east-1", "moon-1"] },
    { source: "aws", regions: "some" },
    [],
  ]) assert.equal(parseConnectionInput(bad, profiles).ok, false, JSON.stringify(bad));
  assert.deepEqual(parseConnectionInput({ source: "aws", regions: "all-enabled" }), { ok: true, value: { source: "aws", regions: "all-enabled" } });
  // The page's words, not the field's: a user's ARN where a role's belongs is the usual mistake.
  assert.match((parseConnectionInput({ source: "aws", signIn: { kind: "role", roleArn: "arn:aws:iam::123456789012:user/ops/alice" } }) as { error: string }).error, /^That's the ARN of the IAM user alice, and only a role can be assumed/);
});

test("role ARNs: a user's or a session's ARN says what to enter instead", () => {
  assert.equal(roleArnProblem(" arn:aws:iam::123456789012:role/console-readonly "), undefined);
  assert.equal(roleArnProblem("arn:aws-us-gov:iam::123456789012:role/path/console-readonly"), undefined);
  assert.match(roleArnProblem("arn:aws:iam::123456789012:user/alice")!, /IAM user alice.*use a saved profile or the machine's own login/);
  assert.match(roleArnProblem("arn:aws:sts::123456789012:assumed-role/console-readonly/alice@example.com")!, /session of the role console-readonly.*try arn:aws:iam::123456789012:role\/console-readonly /);
  for (const bad of ["", "console-readonly", "arn:aws:iam::1234:role/r", "arn:aws:iam::123456789012:group/ops"]) assert.equal(roleArnProblem(bad), "Enter a role's ARN, such as arn:aws:iam::123456789012:role/name.", bad);
});

test("identity ARNs read as who they are", () => {
  assert.equal(describeArn("arn:aws:iam::123456789012:user/ops/alice"), "user alice");
  assert.equal(describeArn("arn:aws:sts::123456789012:assumed-role/deployment-console-task/0f1e2d3c"), "role deployment-console-task");
  assert.equal(describeArn("arn:aws:iam::123456789012:root"), "the account's root user");
  assert.equal(describeArn("arn:aws:sts::123456789012:federated-user/bob"), "federated user bob");
  assert.equal(describeArn("not an arn"), "not an arn");
});

test("sign-in failures: a machine with no AWS login says what to do; anything else keeps AWS's words", () => {
  const none = { name: "CredentialsProviderError", message: "Could not load credentials from any providers" };
  const detail = "CredentialsProviderError: Could not load credentials from any providers";
  assert.match(signInFailure({ kind: "chain" }, none, detail), /^This machine has no AWS login of its own\. On AWS, give the console an ECS task role/);
  assert.match(signInFailure({ kind: "role", roleArn: "arn:aws:iam::123456789012:role/r" }, none, detail), /^Switching into a role starts from this machine's own login, and it has none/);
  assert.match(signInFailure({ kind: "profile", profile: "console-readonly" }, none, detail), /^The profile console-readonly gives this machine no AWS credentials/);
  assert.equal(signInFailure({ kind: "chain" }, { name: "InvalidClientTokenId", message: "The security token included in the request is invalid." }, "InvalidClientTokenId: invalid"), "Couldn't sign in to AWS: InvalidClientTokenId: invalid");
  assert.equal(signInFailure({ kind: "chain" }, null, "timed out"), "Couldn't sign in to AWS: timed out");
  // A role AWS won't let the console switch into: either side may refuse, and AWS words both the same.
  const refused = { name: "AccessDenied", message: "User: arn:aws:iam::123456789012:user/alice is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::210987654321:role/deployment-console-access" };
  assert.match(signInFailure({ kind: "role", roleArn: "arn:aws:iam::210987654321:role/deployment-console-access" }, refused, "denied"), /^AWS didn't let this console's own login switch into arn:aws:iam::210987654321:role\/deployment-console-access\. The role's trust policy must name that login and the external ID/);
  assert.equal(signInFailure({ kind: "chain" }, refused, "denied"), "Couldn't sign in to AWS: denied");
});

test("connection: a damaged stored row counts as no choice", () => {
  const row = JSON.stringify(saved({ signIn: { kind: "profile", profile: "console-readonly" }, home: "eu-west-1", rev: 3 }));
  assert.deepEqual(parseSaved(row), { source: "aws", signIn: { kind: "profile", profile: "console-readonly" }, home: "eu-west-1", rev: 3, by: "admin@example.com", at: 1 });
  for (const bad of [null, "", "{", "[]", JSON.stringify({ source: "aws" }), JSON.stringify(saved({ home: "mars" }))]) assert.equal(parseSaved(bad), null, String(bad));
});

test("profile names: section headers only, default first, sso-session and services sections left out", () => {
  const config = "[default]\nregion = eu-west-1\n[profile console-readonly]\nrole_arn = arn:aws:iam::123456789012:role/r\n[sso-session acme]\n[services s3]\n[ profile  spaced ] ; note\n";
  const creds = "[default]\naws_access_key_id = AKIAEXAMPLE\n[ci]\naws_secret_access_key = wJalrXUtnFEMI\n";
  assert.deepEqual(profileNames(config, creds), ["default", "ci", "console-readonly", "spaced"]);
  assert.deepEqual(profileNames(), []);
});

test("profile kinds: how each login lasts, from setting names only, a role_arn before keys as the SDK reads it", () => {
  const config = [
    "[default]", "region = eu-west-1",
    "[profile console-readonly]", "role_arn = arn:aws:iam::123456789012:role/r", "source_profile = default",
    "[profile ops]", "sso_session = acme",
    "[profile laptop]", "login_session = arn:aws:iam::123456789012:user/alice",
    "[profile tool]", "credential_process = /usr/local/bin/creds",
    "[profile bare]", "region = us-east-1",
    "[sso-session acme]", "sso_start_url = https://acme.awsapps.com/start",
  ].join("\n");
  const creds = ["[default]", "aws_access_key_id = AKIAEXAMPLE", "aws_secret_access_key = wJalrXUtnFEMI", "[ci]", "aws_access_key_id = ASIAEXAMPLE", "aws_session_token = x", "[console-readonly]", "aws_access_key_id = AKIAEXAMPLE2"].join("\n");
  assert.deepEqual(profileKinds(config, creds), { default: "keys", "console-readonly": "role", ops: "sso", laptop: "login", tool: "process", bare: "other", ci: "temporary-keys" });
  assert.deepEqual(profileKinds(), {});
});

test("new profiles: an IAM user's long-term key only, and nothing that could add lines to the credentials file", () => {
  const ok = { name: "deployment-console", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  assert.deepEqual(parseNewProfile({ ...ok, name: " deployment-console " }), ok);
  assert.equal(credentialsSection(ok), "[deployment-console]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");
  assert.match((parseNewProfile({ ...ok, accessKeyId: "ASIAIOSFODNN7EXAMPLE" }) as { error: string }).error, /temporary key/);
  for (const bad of [
    { ...ok, name: "" },
    { ...ok, name: "a]\n[default" },
    { ...ok, accessKeyId: "AKIAIOSFODNN7EXAMPLE\naws_session_token = x" },
    { ...ok, accessKeyId: "akiaiosfodnn7example" },
    { ...ok, secretAccessKey: "short" },
    { ...ok, secretAccessKey: `${ok.secretAccessKey}\n[x]` },
    null,
  ]) assert.ok("error" in parseNewProfile(bad), JSON.stringify(bad));
});

test("home suggestion: the region with most ECS clusters, the current home on a tie, none without clusters", () => {
  assert.equal(suggestHome([{ region: "us-east-1", clusters: 1 }, { region: "ap-south-1", clusters: 2 }]), "ap-south-1");
  assert.equal(suggestHome([{ region: "us-east-1", clusters: 1 }, { region: "eu-west-1", clusters: 1 }], "eu-west-1"), "eu-west-1");
  assert.equal(suggestHome([{ region: "us-east-1", clusters: 0 }, { region: "eu-west-1" }]), undefined);
  assert.equal(scopeKey("aws", "123456789012", "eu-west-1"), "aws:123456789012:eu-west-1");
  assert.equal(describeSignIn({ kind: "role", roleArn: "arn:aws:iam::123456789012:role/r", externalId: "secret-ish" }), "role arn:aws:iam::123456789012:role/r (external ID set)");
  assert.equal(describeSignIn({ kind: "chain" }), "the machine's own login");
});

test("a write from a page loaded before a switch is stale; reads, sign-in, own preferences and token callers aren't", () => {
  const w = (method: string, path: string, sent: string | null) => staleWrite({ method, path, sent, current: "now" });
  assert.equal(w("POST", "/api/services/restart", "before"), true);
  assert.equal(w("PUT", "/api/connection", "before"), true);
  assert.equal(w("POST", "/api/approvals/a1/decide", "before"), true);
  assert.equal(w("DELETE", "/api/notes/n1", ""), true, "a page loaded before the first scope was recorded");
  assert.equal(w("POST", "/api/services/restart", "now"), false);
  assert.equal(w("POST", "/api/ops/services.restart", null), false, "API and agent tokens send none");
  assert.equal(w("GET", "/api/overview", "before"), false);
  assert.equal(w("POST", "/api/auth/logout", "before"), false);
  assert.equal(w("PUT", "/api/me/prefs", "before"), false);
  assert.equal(w("POST", "/api/media", "before"), true, "a path that only starts like /api/me is no exemption");
});
