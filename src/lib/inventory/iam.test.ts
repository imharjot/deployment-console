import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { decodePolicy, iamDetail, iamResult, slimRole, trustOf, type RawRole } from "./iam.ts";
import { simRoles } from "../server/providers/mock/iam.ts";

const ACCT = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const SENTINEL = "SENTINEL-iam-7f3a9c";
const enc = (doc: unknown) => encodeURIComponent(JSON.stringify(doc));
const allow = (Principal: unknown, Condition?: unknown) => enc({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal, Action: "sts:AssumeRole", ...(Condition ? { Condition } : {}) }] });
const role = (name: string, o: Partial<RawRole> = {}): RawRole => ({
  Path: "/", RoleName: name, RoleId: `AROA${name.toUpperCase().replace(/[^A-Z]/g, "")}`, Arn: `arn:aws:iam::${ACCT}:role/${name}`, CreateDate: new Date(NOW - 300 * DAY),
  AssumeRolePolicyDocument: allow({ Service: "ecs-tasks.amazonaws.com" }), Tags: [], RoleLastUsed: { LastUsedDate: new Date(NOW - DAY), Region: "us-east-1" }, ...o,
});

// Golden input: what GetAccountAuthorizationDetails returns (documents URL-encoded), seeded with secret sentinels in an
// inline policy document and an external id value.
const GOLDEN: RawRole[] = [
  role("api-task", {
    Tags: [{ Key: "Environment", Value: "production" }],
    AttachedManagedPolicies: [{ PolicyName: "AmazonS3ReadOnlyAccess", PolicyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess" }],
    RolePolicyList: [{ PolicyName: "data", PolicyDocument: enc({ Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${SENTINEL}/*` }] }) }],
    PermissionsBoundary: { PermissionsBoundaryArn: `arn:aws:iam::${ACCT}:policy/boundary-app`, PermissionsBoundaryType: "Policy" },
  }),
  role("ecs-host", {
    AssumeRolePolicyDocument: allow({ Service: "ec2.amazonaws.com" }),
    InstanceProfileList: [{ InstanceProfileName: "ecs-host-profile", Arn: `arn:aws:iam::${ACCT}:instance-profile/ecs-host-profile`, Path: "/", Roles: [{ AssumeRolePolicyDocument: SENTINEL }] }],
  }),
  role("partner-no-extid", { AssumeRolePolicyDocument: allow({ AWS: "arn:aws:iam::210987654321:root" }) }),
  role("partner-extid", { AssumeRolePolicyDocument: allow({ AWS: "210987654321" }, { StringEquals: { "sts:ExternalId": SENTINEL } }) }),
  role("open-to-all", { AssumeRolePolicyDocument: allow("*") }),
  role("open-with-condition", { AssumeRolePolicyDocument: allow({ AWS: "*" }, { StringEquals: { "aws:PrincipalOrgID": "o-acme123" } }) }),
  role("github-deploy", { AssumeRolePolicyDocument: allow({ Federated: `arn:aws:iam::${ACCT}:oidc-provider/token.actions.githubusercontent.com` }, { StringLike: { "token.actions.githubusercontent.com:sub": "repo:acme/*" } }) }),
  role("AWSServiceRoleForECS", { Path: "/aws-service-role/ecs.amazonaws.com/", Arn: `arn:aws:iam::${ACCT}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`, AssumeRolePolicyDocument: allow({ Service: "ecs.amazonaws.com" }) }),
  role("AWSReservedSSO_Admin_1a2b", { Path: "/aws-reserved/sso.amazonaws.com/", Arn: `arn:aws:iam::${ACCT}:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_1a2b`, RoleLastUsed: {} }),
  role("old-deployer", { RoleLastUsed: {}, CreateDate: new Date(NOW - 200 * DAY) }),
  role("brand-new", { RoleLastUsed: {}, CreateDate: new Date(NOW - 2 * DAY) }),
  role("bad-trust", { AssumeRolePolicyDocument: "%7Bnot json" }),
];

const result = () => iamResult(GOLDEN.map(slimRole), { now: NOW, idleDays: 14, account: ACCT });
const byName = (name: string) => result().resources.find((r) => r.name === name)!;

test("IAM: keys, global region, names-only policies, aliases (role name, RoleId, instance profiles)", () => {
  const api = byName("api-task");
  assert.equal(api.key, `arn:aws:iam::${ACCT}:role/api-task`);
  assert.equal(api.kind, "iam-role");
  assert.equal(api.region, "global");
  assert.deepEqual(api.tags, { Environment: "production" });
  assert.equal(api.tagsUnread, undefined, "GetAccountAuthorizationDetails returns tags");
  assert.equal(api.props.find((p) => p.label === "Policies")?.value, "AmazonS3ReadOnlyAccess, data (inline)");
  assert.equal(api.props.find((p) => p.label === "Permissions boundary")?.value, "boundary-app");
  assert.equal(api.props.find((p) => p.label === "Trusted by")?.value, "ecs-tasks.amazonaws.com");
  assert.equal(api.lastActivityAt, NOW - DAY);
  const host = byName("ecs-host");
  assert.deepEqual(host.aliases, ["ecs-host", "AROAECSHOST", `arn:aws:iam::${ACCT}:instance-profile/ecs-host-profile`, "ecs-host-profile"]);
  assert.equal(result().links.length, 0);
});

test("IAM: the trust policy is URL-decoded — Principal * with no condition is an error, another account without an external id a warning", () => {
  assert.equal(byName("open-to-all").health, "error");
  assert.match(byName("open-to-all").healthReason ?? "", /Principal \* with no condition/);
  assert.equal(byName("open-with-condition").health, "ok", "a condition narrows *");
  assert.equal(byName("partner-no-extid").health, "warning");
  assert.equal(byName("partner-no-extid").healthReason, "account 210987654321 can assume it without an external id (sts:ExternalId)");
  assert.equal(byName("partner-no-extid").props.find((p) => p.label === "Trusted by")?.value, "account 210987654321");
  assert.equal(byName("partner-extid").health, "ok");
  assert.equal(byName("github-deploy").props.find((p) => p.label === "Trusted by")?.value, "token.actions.githubusercontent.com (OIDC)");
  assert.equal(byName("bad-trust").health, "unknown");
  // Same-account principals never warn.
  assert.equal(byName("old-deployer").health, "ok");
  const t = trustOf(allow({ AWS: [`arn:aws:iam::${ACCT}:role/ci`, "arn:aws:iam::999988887777:role/x"] }), ACCT)!;
  assert.deepEqual(t.warnings, ["account 999988887777 can assume it without an external id (sts:ExternalId)"]);
  assert.deepEqual(decodePolicy({ Statement: [] }), { Statement: [] }, "the CLI's already-decoded form passes through");
  const not = trustOf(enc({ Statement: [{ Effect: "Allow", NotPrincipal: { AWS: "arn:aws:iam::1:root" }, Action: "sts:AssumeRole" }] }), ACCT)!;
  assert.match(not.error ?? "", /everyone except/);
});

test("IAM: service-linked and reserved roles are hidden; never used after the idle window is facts.neverUsed", () => {
  assert.equal(byName("AWSServiceRoleForECS").hidden, true);
  assert.equal(byName("AWSReservedSSO_Admin_1a2b").hidden, true);
  assert.equal(byName("AWSReservedSSO_Admin_1a2b").facts, undefined, "hidden roles are never idle");
  assert.equal(byName("api-task").hidden, undefined);
  assert.deepEqual(byName("old-deployer").facts, { neverUsed: true });
  assert.equal(byName("old-deployer").props.find((p) => p.label === "Last used")?.value, "never (IAM tracks the last 400 days)");
  assert.equal(byName("brand-new").facts, undefined, "created inside the idle window");
});

test("IAM: no policy document or external id value survives — slimRole, resources and detail", () => {
  const slim = GOLDEN.map(slimRole);
  assert.ok(!JSON.stringify(slim.map((r) => [r.RolePolicyList, r.InstanceProfileList])).includes(SENTINEL), "slimRole keeps policy names and profile ids only");
  const out = JSON.stringify(result());
  assert.ok(!out.includes(SENTINEL), "sentinel leaked into resources");
  const details = JSON.stringify(slim.map((r) => iamDetail(r.Arn!, r)));
  assert.ok(!details.includes(SENTINEL), "sentinel leaked into detail");
  assert.match(details, /sts:ExternalId = \(set\)/);
});

test("IAM: detail renders the cached role — trust table, policy names, use — and says so when nothing is cached", () => {
  const d = iamDetail("k", slimRole(GOLDEN[0]));
  assert.deepEqual(d.sections.map((s) => s.title), ["Who can assume it", "Permissions", "Use"]);
  assert.deepEqual(d.sections[0].table?.rows, [["Service", "ecs-tasks.amazonaws.com", "—"]]);
  assert.equal(d.sections[1].rows?.find((r) => r.label === "Inline policies")?.value, "data");
  assert.match(iamDetail("k", undefined).sections[0].note ?? "", /next map refresh/);
});

test("IAM: the Acme simulation — 14 roles, the service-linked one hidden, the partner warned, the old deployer never used", () => {
  const roles = simRoles(NOW);
  const r = iamResult(roles, { now: NOW, idleDays: 14, account: ACCT });
  assert.equal(r.resources.length, 14);
  assert.deepEqual(r.resources.filter((x) => x.hidden).map((x) => x.name), ["AWSServiceRoleForECS"]);
  assert.deepEqual(r.resources.filter((x) => x.health !== "ok").map((x) => [x.name, x.health]), [["acme-partner-readonly", "warning"]]);
  assert.deepEqual(r.resources.filter((x) => x.facts?.neverUsed).map((x) => x.name), ["acme-old-deployer"]);
  const host = r.resources.find((x) => x.name === "acme-ecs-instance")!;
  assert.ok(host.aliases?.includes(`arn:aws:iam::${ACCT}:instance-profile/acme-ecs-instance`));
  assert.equal(r.resources.find((x) => x.name === "acme-codebuild")?.key, `arn:aws:iam::${ACCT}:role/service-role/acme-codebuild`);
});

// The provider's I/O (CC-9): one paged GetAccountAuthorizationDetails (Filter Role, 1,000 per page, Marker), nothing
// else; the cached copy holds no policy document; detail() makes no call. providers/iam.ts imports "server-only": child
// process, react-server condition, the SDK's send() faked.
test("IAM provider: only GetAccountAuthorizationDetails, paged by Marker; detail() serves the slim cache without a call", () => {
  const provider = new URL("../server/providers/iam.ts", import.meta.url).href;
  const script = `
    const { IAMClient } = await import("@aws-sdk/client-iam");
    const calls = [];
    const doc = encodeURIComponent(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }] }));
    const role = (n) => ({ Path: "/", RoleName: n, RoleId: "AROA" + n, Arn: "arn:aws:iam::${ACCT}:role/" + n, CreateDate: new Date(), AssumeRolePolicyDocument: doc, Tags: [],
      RolePolicyList: [{ PolicyName: "inline", PolicyDocument: "${SENTINEL}" }] });
    IAMClient.prototype.send = async function (cmd) {
      const op = cmd.constructor.name.replace(/Command$/, ""), i = cmd.input;
      calls.push([op, i.Filter ?? null, i.MaxItems ?? null, i.Marker ?? null, await this.config.region()]);
      if (op !== "GetAccountAuthorizationDetails") throw new Error("unexpected " + op);
      return i.Marker ? { RoleDetailList: [role("b")], IsTruncated: false } : { RoleDetailList: [role("a")], IsTruncated: true, Marker: "m1" };
    };
    const { iamProvider } = await import(${JSON.stringify(provider)});
    const ctx = { region: "us-east-1", home: "ap-south-1", accountId: "${ACCT}", mock: false, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: () => {} };
    const r = await iamProvider.discover(ctx);
    const before = calls.length;
    const d = await iamProvider.detail(r.resources[1], ctx);
    process.stdout.write(JSON.stringify({ calls, before, after: calls.length, keys: r.resources.map((x) => x.key), detail: d, cache: [...globalThis.__consoleIamRoles.get("${ACCT}").roles.values()] }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  assert.deepEqual(out.calls, [["GetAccountAuthorizationDetails", ["Role"], 1000, null, "us-east-1"], ["GetAccountAuthorizationDetails", ["Role"], 1000, "m1", "us-east-1"]]);
  assert.deepEqual(out.keys, [`arn:aws:iam::${ACCT}:role/a`, `arn:aws:iam::${ACCT}:role/b`]);
  assert.equal(out.after, out.before, "detail() made no AWS call");
  assert.equal(out.detail.sections[1].rows.find((r: { label: string }) => r.label === "Inline policies").value, "inline");
  assert.ok(!JSON.stringify(out.cache).includes(SENTINEL), "the cache holds policy names, not documents");
});
