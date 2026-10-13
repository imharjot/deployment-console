// Policy building from provider declarations: classes, deduplication, Sids, splitting, placeholders, the CLI snippet.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPolicy, cliScript, cloudflareScopes, declarationOf, describeProvider, docsSection, fillPlaceholders, forRegions, implicitClass, placeholdersIn, policySize, sidOf,
  splitPolicy, validPlaceholder, validPrincipalArn, withDocsSection, withPrincipal, DOCS_BEGIN, DOCS_END, MANAGED_POLICY_LIMIT, NOT_IMPLEMENTED, SIMULATE_SID,
  type Declaration, type PolicyDocument, type Statement,
} from "./permissions.ts";

const lambda: Declaration = {
  id: "lambda",
  label: "Lambda",
  read: ["lambda:ListFunctions", "lambda:ListEventSourceMappings", "lambda:ListFunctions", "ec2:DescribeSecurityGroups"],
  sensitive: ["lambda:GetFunction"],
  write: ["lambda:UpdateFunctionCode", "lambda:UpdateAlias"],
  implicit: ["iam:PassRole", "ecr:BatchGetImage", "ecr:DescribeImages", "kms:GenerateDataKey"],
};
const sqs: Declaration = { id: "sqs", label: "SQS", read: ["sqs:ListQueues", "ec2:DescribeSecurityGroups"], sensitive: ["sqs:ReceiveMessage"], write: ["sqs:PurgeQueue"], implicit: ["kms:Decrypt"] };
const cloudflare: Declaration = { id: "cloudflare", label: "Cloudflare", global: true, read: ["cloudflare:Zone:Read", "cloudflare:DNS:Read"], write: ["cloudflare:Cache Purge"] };
const base: Statement[] = [
  { Sid: "DiscoverAndRead", Effect: "Allow", Resource: "*", Action: ["ec2:DescribeSecurityGroups", "ecr:DescribeImages"] },
  { Sid: "Scoped", Effect: "Allow", Resource: "arn:aws:s3:::bucket/*", Action: ["lambda:UpdateAlias"] },
  { Sid: "Kms", Effect: "Allow", Resource: "*", Action: ["kms:Decrypt"], Condition: { StringLike: { "kms:ViaService": ["ssm.REGION.amazonaws.com"] } } },
  { Sid: "Deny", Effect: "Deny", Resource: "*", Action: ["lambda:ListFunctions"] },
];
const sidsOf = (doc: PolicyDocument) => doc.Statement.map((s) => s.Sid);
const byId = (doc: PolicyDocument, sid: string) => doc.Statement.find((s) => s.Sid === sid)?.Action;

test("read-only: one Read statement per provider, sorted, deduplicated against unconditional grants", () => {
  const { policy } = buildPolicy([sqs, lambda, cloudflare], "read", base);
  assert.deepEqual(sidsOf(policy), ["DiscoverAndRead", "Scoped", "Kms", "Deny", "InventoryLambdaRead", "InventorySqsRead"]);
  // ec2:DescribeSecurityGroups is granted everywhere by DiscoverAndRead; ecr:DescribeImages (implicit read) too.
  assert.deepEqual(byId(policy, "InventoryLambdaRead"), ["lambda:ListEventSourceMappings", "lambda:ListFunctions"]);
  assert.deepEqual(byId(policy, "InventorySqsRead"), ["sqs:ListQueues"]);
  assert.deepEqual(buildPolicy([sqs, lambda], "read", []).skipped, [], "iam/kms implicit actions of other classes don't matter to the read-only policy");
  const all = policy.Statement.flatMap((s) => [s.Action ?? []].flat());
  assert.ok(!all.some((a) => a.startsWith("cloudflare:")), "Cloudflare scopes aren't IAM");
  assert.ok(!all.includes("sqs:PurgeQueue") && !all.includes("lambda:GetFunction"), "no write or sensitive in read-only");
});

test("full: Read, Sensitive and Write; implicit actions classed; a hand-written scoped grant is never widened", () => {
  const { policy, skipped } = buildPolicy([lambda, sqs], "full", base);
  assert.deepEqual(sidsOf(policy).slice(4), ["InventoryLambdaRead", "InventoryLambdaSensitive", "InventoryLambdaWrite", "InventorySqsRead", "InventorySqsSensitive", "InventorySqsWrite"]);
  assert.deepEqual(byId(policy, "InventoryLambdaWrite"), ["ecr:BatchGetImage", "lambda:UpdateFunctionCode"], "UpdateAlias is granted by hand on some resources only: that scope stays the limit, no generated \"*\" beside it");
  assert.deepEqual(byId(policy, "InventorySqsSensitive"), ["sqs:ReceiveMessage"], "kms:Decrypt is only ever granted by hand-written statements");
  assert.deepEqual(skipped.map((s) => `${s.provider}:${s.action}`), ["lambda:iam:PassRole", "lambda:kms:GenerateDataKey"], "kms:Decrypt is granted by the hand-written Kms statement, so not skipped");
  for (const s of policy.Statement.slice(4)) assert.equal(s.Resource, "*");
});

test("an action shared by two providers is granted once, by the first id", () => {
  const { policy } = buildPolicy([sqs, lambda], "read", []);
  assert.deepEqual(byId(policy, "InventoryLambdaRead"), ["ec2:DescribeSecurityGroups", "ecr:DescribeImages", "lambda:ListEventSourceMappings", "lambda:ListFunctions"]);
  assert.deepEqual(byId(policy, "InventorySqsRead"), ["sqs:ListQueues"]);
});

test("rebuilding replaces earlier Inventory statements and is deterministic", () => {
  const first = buildPolicy([lambda, sqs], "full", base).policy;
  const again = buildPolicy([sqs, lambda], "full", first.Statement).policy;
  assert.deepEqual(again, first);
  const fewer = buildPolicy([sqs], "full", first.Statement).policy;
  assert.ok(!sidsOf(fewer).some((s) => s?.startsWith("InventoryLambda")));
});

test("Sids", () => {
  assert.equal(sidOf("api-gateway"), "ApiGateway");
  assert.equal(sidOf("route53"), "Route53");
  assert.throws(() => buildPolicy([{ id: "a-b", label: "x", read: ["s3:ListAllMyBuckets"] }, { id: "a_b", label: "y", read: ["s3:GetBucketTagging"] }], "read"), /Sid InventoryABRead|distinct ids/);
});

test("implicit classes", () => {
  assert.equal(implicitClass("cloudformation:DescribeStackResources"), "read");
  assert.equal(implicitClass("autoscaling:DescribeAutoScalingGroups"), "read");
  assert.equal(implicitClass("kms:Decrypt"), "sensitive");
  assert.equal(implicitClass("kms:GenerateDataKey"), "write");
  assert.equal(implicitClass("iam:PassRole"), "write");
});

test("Cloudflare scopes", () => {
  assert.deepEqual(cloudflareScopes([cloudflare, lambda]), [
    { scope: "Cache Purge", providers: ["cloudflare"], write: true },
    { scope: "DNS:Read", providers: ["cloudflare"], write: false },
    { scope: "Zone:Read", providers: ["cloudflare"], write: false },
  ]);
  const p = describeProvider(cloudflare);
  assert.deepEqual([p.scopes, p.writeScopes, p.read, p.write], [["DNS:Read", "Zone:Read"], ["Cache Purge"], [], []]);
  const both = cloudflareScopes([cloudflare, { id: "cf2", label: "x", read: ["cloudflare:Cache Purge"] }]);
  assert.equal(both[0].write, false, "a scope any provider needs to discover counts as a read scope");
});

test("describeProvider: kinds, enabled, dedupe", () => {
  const p = describeProvider({ ...lambda, enabled: () => ({ ok: false, why: "set X" }), actions: [{ id: "deploy", title: "Deploy", kind: "lambda", risk: "change", perm: "act" }] });
  assert.deepEqual(p.kinds, ["lambda"]);
  assert.deepEqual(p.enabled, { ok: false, why: "set X" });
  assert.deepEqual(p.read, ["ec2:DescribeSecurityGroups", "lambda:ListEventSourceMappings", "lambda:ListFunctions"]);
  assert.deepEqual(describeProvider({ id: "eventbridge", label: "EventBridge", read: [] }).kinds, ["eventbridge-rule", "eventbridge-bus"]);
  const kinds = (id: string, label: string) => describeProvider({ id, label, read: [] }).kinds;
  assert.deepEqual(kinds("ecs", "ECS services"), ["ecs-service"]);
  assert.deepEqual(kinds("elb", "Load balancers"), ["loadbalancer"]);
  assert.deepEqual(kinds("rds", "RDS databases"), ["rds"]);
  assert.deepEqual(kinds("asg", "EC2 Auto Scaling"), ["asg"]);
  assert.deepEqual(kinds("eks", "EKS"), ["eks-cluster", "eks-workload"]);
  assert.deepEqual(kinds("route53", "Route 53"), ["route53-zone", "health-check"], "health checks are route53's (KIND_INFO owner)");
  assert.deepEqual(kinds("elasticache", "ElastiCache"), ["elasticache"], "serverless caches belong to elasticache-serverless");
  assert.deepEqual(kinds("ec2", "EC2"), ["ec2-instance"], "security groups and EBS volumes have their own providers");
  assert.deepEqual(describeProvider({ id: "x", label: "X", read: [], enabled: () => { throw new Error("boom"); } }).enabled, { ok: false, why: "boom" });
});

test("declared kinds, scope and covers win over the name heuristics, and reach --json", () => {
  const vpc: Declaration = {
    id: "vpc", label: "VPC networking", scope: "regional", kinds: ["vpc", "subnet", "vpc"], covers: ["ec2:vpc", "ec2:subnet"], read: [],
  };
  const p = describeProvider(vpc);
  assert.deepEqual(p.kinds, ["vpc", "subnet"]);
  assert.equal(p.scope, "regional");
  assert.deepEqual(p.covers, ["ec2:subnet", "ec2:vpc"]);
  const iam = describeProvider({ id: "iam", label: "IAM roles", scope: "global", homeRegion: "us-east-1", kinds: ["iam-role"], read: [] });
  assert.deepEqual([iam.scope, iam.homeRegion, iam.kinds], ["global", "us-east-1", ["iam-role"]]);
  assert.equal(describeProvider(cloudflare).scope, "global", "global: true is scope global");
  assert.equal(describeProvider(sqs).scope, "regional", "the default");
  assert.deepEqual(describeProvider(sqs).covers, []);
  const stub = describeProvider({ ...vpc, enabled: () => ({ ok: false, why: NOT_IMPLEMENTED }) });
  assert.equal(stub.planned, true, "a stub is coming, not something to set up");
  assert.equal(describeProvider({ ...vpc, enabled: () => ({ ok: false, why: "set CLOUDFLARE_API_TOKEN" }) }).planned, undefined);
  assert.equal("planned" in describeProvider(sqs), false);
  assert.deepEqual(declarationOf({ ...vpc, write: [] }), { id: "vpc", label: "VPC networking", scope: "regional", kinds: ["vpc", "subnet", "vpc"], covers: ["ec2:vpc", "ec2:subnet"], read: [] });
  assert.deepEqual(declarationOf(sqs), sqs, "nothing new for a provider that declares nothing new");
  assert.deepEqual(Object.keys(declarationOf({ ...iam, read: [] } as Declaration)), ["id", "label", "scope", "homeRegion", "kinds", "read"]);
});

test("splitPolicy keeps every statement and action, each part under the limit", () => {
  const many = Array.from({ length: 400 }, (_, i) => `lambda:Action${String(i).padStart(3, "0")}`);
  const doc: PolicyDocument = { Version: "2012-10-17", Statement: [...base, { Sid: "InventoryBigRead", Effect: "Allow", Resource: "*", Action: many }] };
  assert.ok(policySize(doc) > MANAGED_POLICY_LIMIT);
  const parts = splitPolicy(doc);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(policySize(p) <= MANAGED_POLICY_LIMIT, `part is ${policySize(p)}`);
  const actions = parts.flatMap((p) => p.Statement.filter((s) => s.Sid?.startsWith("InventoryBigRead")).flatMap((s) => [s.Action ?? []].flat()));
  assert.deepEqual(actions, many);
  const sids = parts.flatMap(sidsOf);
  assert.equal(new Set(sids).size, sids.length, "Sids stay unique");
  assert.deepEqual(sids.slice(0, 4), ["DiscoverAndRead", "Scoped", "Kms", "Deny"]);
  assert.deepEqual(splitPolicy({ Version: "2012-10-17", Statement: base }), [{ Version: "2012-10-17", Statement: base }], "small documents stay whole");
});

test("placeholders: found, filled only with valid values, only in Resource/Condition", () => {
  const doc: PolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      { Sid: "REGIONAL", Effect: "Allow", Action: ["ecs:UpdateService"], Resource: "arn:aws:ecs:REGION:ACCOUNT_ID:service/CONSOLE_CLUSTER/CONSOLE_SERVICE" },
      { Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::ENV_FILES_BUCKET/*", Condition: { StringLike: { "kms:ViaService": ["ssm.REGION.amazonaws.com"] } } },
    ],
  };
  assert.deepEqual(placeholdersIn(doc), ["ACCOUNT_ID", "REGION", "CONSOLE_CLUSTER", "CONSOLE_SERVICE", "ENV_FILES_BUCKET"]);
  const filled = fillPlaceholders(doc, { REGION: "eu-west-1", ACCOUNT_ID: "123456789012", CONSOLE_CLUSTER: "tools", ENV_FILES_BUCKET: "bad bucket\"" });
  assert.equal(filled.Statement[0].Resource, "arn:aws:ecs:eu-west-1:123456789012:service/tools/CONSOLE_SERVICE");
  assert.equal(filled.Statement[0].Sid, "REGIONAL", "Sids untouched");
  assert.equal(filled.Statement[1].Resource, "arn:aws:s3:::ENV_FILES_BUCKET/*", "an invalid value is ignored");
  assert.deepEqual(filled.Statement[1].Condition, { StringLike: { "kms:ViaService": ["ssm.eu-west-1.amazonaws.com"] } });
  assert.deepEqual(placeholdersIn(filled), ["CONSOLE_SERVICE", "ENV_FILES_BUCKET"]);
  assert.equal(fillPlaceholders(doc, { ACCOUNT_ID: "12" }), doc);
});

test("F34 placeholders: the console's parameter path, secret prefix and env file, filled only with valid values", () => {
  const doc: PolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      { Sid: "P", Effect: "Deny", Action: ["ssm:GetParameter"], Resource: "arn:aws:ssm:*:ACCOUNT_ID:parameter/CONSOLE_PARAM_PREFIX/*" },
      { Sid: "S", Effect: "Deny", Action: ["secretsmanager:GetSecretValue"], Resource: "arn:aws:secretsmanager:*:ACCOUNT_ID:secret:CONSOLE_SECRET_PREFIX*" },
      { Sid: "F", Effect: "Deny", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::ENV_FILES_BUCKET/CONSOLE_ENV_FILE" },
    ],
  };
  assert.deepEqual(placeholdersIn(doc), ["ACCOUNT_ID", "ENV_FILES_BUCKET", "CONSOLE_PARAM_PREFIX", "CONSOLE_SECRET_PREFIX", "CONSOLE_ENV_FILE"]);
  const good = fillPlaceholders(doc, { CONSOLE_PARAM_PREFIX: "deployment-console", CONSOLE_SECRET_PREFIX: "deployment-console/", CONSOLE_ENV_FILE: "deployment-console/production.env", ENV_FILES_BUCKET: "acme-env-files" });
  assert.deepEqual(good.Statement.map((s) => s.Resource), [
    "arn:aws:ssm:*:ACCOUNT_ID:parameter/deployment-console/*",
    "arn:aws:secretsmanager:*:ACCOUNT_ID:secret:deployment-console/*",
    "arn:aws:s3:::acme-env-files/deployment-console/production.env",
  ]);
  // A leading slash, quotes, spaces or "$&" (a replacement pattern) never reach the document.
  for (const [p, v] of [["CONSOLE_PARAM_PREFIX", "/deployment-console"], ["CONSOLE_PARAM_PREFIX", "a/"], ["CONSOLE_SECRET_PREFIX", "x\" y"], ["CONSOLE_ENV_FILE", "/abs.env"], ["CONSOLE_ENV_FILE", "a$&b"]] as const)
    assert.equal(fillPlaceholders(doc, { [p]: v }), doc, `${p}=${v}`);
  assert.ok(validPlaceholder("CONSOLE_ENV_FILE", "deployment-console/*"), "a wildcard covers several env files");
});

test("forRegions: more than one region widens REGION to * (kms:ViaService and ARNs); one region changes nothing", () => {
  const doc: PolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      { Sid: "ServiceActions", Effect: "Allow", Action: ["ecs:UpdateService"], Resource: "arn:aws:ecs:REGION:ACCOUNT_ID:service/*/*" },
      { Sid: "Kms", Effect: "Allow", Action: ["kms:Decrypt"], Resource: "*", Condition: { StringLike: { "kms:ViaService": ["ssm.REGION.amazonaws.com", "secretsmanager.REGION.amazonaws.com"] } } },
    ],
  };
  assert.equal(forRegions(doc, ["eu-west-1"]), doc);
  assert.equal(forRegions(doc, ["eu-west-1", "eu-west-1"]), doc, "duplicates are one region");
  assert.equal(forRegions(doc, []), doc);
  const wide = forRegions(doc, ["us-east-1", "eu-west-1"]);
  assert.equal(wide.Statement[0].Resource, "arn:aws:ecs:*:ACCOUNT_ID:service/*/*");
  assert.deepEqual(wide.Statement[1].Condition, { StringLike: { "kms:ViaService": ["ssm.*.amazonaws.com", "secretsmanager.*.amazonaws.com"] } });
  assert.equal(wide.Statement[0].Sid, "ServiceActions");
  assert.deepEqual(placeholdersIn(wide), ["ACCOUNT_ID"]);
  // Filling ACCOUNT_ID afterwards still works; a later REGION fill has nothing left to replace.
  assert.equal(fillPlaceholders(wide, { ACCOUNT_ID: "123456789012", REGION: "eu-west-1" }).Statement[0].Resource, "arn:aws:ecs:*:123456789012:service/*/*");
});

test("withPrincipal: SimulateOwnPermissions names the identity the console runs as; anything else is left alone", () => {
  const doc: PolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      { Sid: SIMULATE_SID, Effect: "Allow", Action: ["iam:SimulatePrincipalPolicy"], Resource: "arn:aws:iam::ACCOUNT_ID:role/deployment-console-task" },
      { Sid: "NeverPassTheConsolesOwnRole", Effect: "Deny", Action: ["iam:PassRole"], Resource: "arn:aws:iam::ACCOUNT_ID:role/deployment-console-task" },
    ],
  };
  const user = withPrincipal(doc, "arn:aws:iam::123456789012:user/deployment-console-local");
  assert.equal(user.Statement[0].Resource, "arn:aws:iam::123456789012:user/deployment-console-local");
  assert.equal(user.Statement[1].Resource, doc.Statement[1].Resource, "only the simulate statement");
  assert.equal(withPrincipal(doc, "arn:aws:iam::ACCOUNT_ID:role/ops/console").Statement[0].Resource, "arn:aws:iam::ACCOUNT_ID:role/ops/console", "a path is fine");
  for (const bad of ["*", "arn:aws:iam::123456789012:group/x", "arn:aws:sts::123456789012:assumed-role/x/y", "arn:aws:iam::1:user/x", "arn:aws:iam::123456789012:user/a\"b"])
    assert.equal(withPrincipal(doc, bad), doc, bad);
  assert.ok(validPrincipalArn("arn:aws-us-gov:iam::123456789012:role/console"));
});

test("cliScript: one file + create + attach per part; unsafe input never reaches the shell", () => {
  const doc: PolicyDocument = { Version: "2012-10-17", Statement: base };
  const one = cliScript({ parts: [doc], mode: "read", role: "deployment-console-task", accountId: "123456789012" });
  assert.match(one, /^ROLE=deployment-console-task /m);
  assert.match(one, /^ACCOUNT_ID=123456789012$/m);
  assert.match(one, /cat > deployment-console-readonly\.json <<'POLICY'\n\{/);
  assert.match(one, /aws iam create-policy --policy-name deployment-console-readonly --policy-document file:\/\/deployment-console-readonly\.json/);
  assert.match(one, /aws iam attach-role-policy --role-name "\$ROLE" --policy-arn "arn:aws:iam::\$ACCOUNT_ID:policy\/deployment-console-readonly"/);
  const two = cliScript({ parts: [doc, doc], mode: "full", role: "x; rm -rf /", accountId: "nope" });
  assert.match(two, /^ROLE=ROLE_NAME /m);
  assert.match(two, /^ACCOUNT_ID=\$\(aws sts get-caller-identity --query Account --output text\)$/m);
  assert.match(two, /policy-name deployment-console-1 /);
  assert.match(two, /policy-name deployment-console-2 /);
});

test("docs section", () => {
  const md = `# x\n\n${DOCS_BEGIN}\nold\n${DOCS_END}\n\nafter\n`;
  const out = withDocsSection(md, [sqs, cloudflare]);
  assert.ok(out.startsWith("# x\n\n") && out.endsWith("\n\nafter\n"));
  assert.match(out, /\| SQS \(`sqs`\) \| `ec2:DescribeSecurityGroups`, `sqs:ListQueues` \| `kms:Decrypt`, `sqs:ReceiveMessage` \| `sqs:PurgeQueue` \|/);
  assert.match(out, /\| Cloudflare \(`cloudflare`\) \| Cloudflare token: `DNS:Read`, `Zone:Read` \| — \| Cloudflare token: `Cache Purge` \|/);
  assert.equal(withDocsSection(out, [sqs, cloudflare]), out);
  assert.match(docsSection([]), /No providers are registered yet/);
  assert.throws(() => withDocsSection("# no markers", []), /markers/);
});
