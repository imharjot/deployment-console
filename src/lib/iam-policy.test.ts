// Keeps the shipped IAM policies and the docs in step with the AWS calls the console actually makes.
//
// Sources: every file under src/lib/server/ importing an AWS SDK client — aws.ts and billing-aws.ts (the ECS console,
// Costs), the providers (src/lib/server/providers/**) and the inventory core. Each imported `…Command` or `paginate…`
// maps to one IAM action through SERVICE / OVERRIDES below (API Gateway uses HTTP-verb actions: apigateway:GET, POST…).
// Waiters, type-only imports and non-client @aws-sdk packages are ignored; so is sts:GetCallerIdentity when nobody
// declares it (it needs no permission). The agents' model adapters (src/lib/server/agents/inference/ and runtime/) are
// not scanned: they call Bedrock with a connection's own credentials, never the console's role, so nothing they import
// belongs in these policies — and @aws-sdk/client-bedrock-runtime may be imported nowhere else. Nor is
// connection-credentials.ts: its sts:AssumeRole is a permission of the identity the console runs as, which assumes the
// role holding these policies (docs/connect-aws.md).
//
// Rules:
// - aws.ts / billing-aws.ts are granted by the hand-written statements; their classes are WRITES / SENSITIVE /
//   IMPLICIT here.
// - Everything else (providers, inventory core): every call must be declared in a provider's `read` (discovery),
//   `sensitive` (reads data) or `write` (actions), and every declared action must be called somewhere. The registry is loaded the way
//   `npm run iam:policy -- --json` loads it (a child process with --conditions=react-server), so lists may be built in
//   code. An action has one class across providers.
// - The Inventory* statements of both policies are exactly what `npm run iam:policy` generates (src/lib/permissions.ts).
// - Read-only policy: every read, no write, no sensitive read, nothing unused. Full policy: every call, nothing unused,
//   the self-protection denies.
// - Docs: aws.ts / billing-aws.ts actions are explained in docs/connect-aws.md; provider actions appear in the generated
//   table of docs/services.md (kept by `npm run iam:policy`). docs/permissions.md explains the classes.
// - Also the infra files' other promises: the F34 denies on the console's own configuration, SimulateOwnPermissions on
//   its own principal only, and the graceful stop settings of the Dockerfile, task definition and compose file (F67).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KIND_INFO } from "./inventory/types.ts";
import {
  baseStatements, buildPolicy, forRegions, handWrittenOnly, implicitClass, isGenerated, isIamAction, placeholdersIn, withDocsSection, withPrincipal, SIMULATE_SID,
  type Declaration, type PolicyDocument,
} from "./permissions.ts";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFile(new URL(p, root), "utf8");

// @aws-sdk package → IAM service prefix.
const SERVICE: Record<string, string> = {
  "client-ecs": "ecs",
  "client-ecr": "ecr",
  "client-cloudwatch-logs": "logs",
  "client-cloudwatch": "cloudwatch",
  "client-ec2": "ec2",
  "client-rds": "rds",
  "client-elasticache": "elasticache",
  "client-elastic-load-balancing-v2": "elasticloadbalancing",
  "client-ssm": "ssm",
  "client-secrets-manager": "secretsmanager",
  "client-s3": "s3",
  "client-cost-explorer": "ce",
  "client-lambda": "lambda",
  "client-sqs": "sqs",
  "client-sns": "sns",
  "client-eventbridge": "events",
  "client-sfn": "states",
  "client-kinesis": "kinesis",
  "client-dynamodb": "dynamodb",
  "client-dynamodb-streams": "dynamodb",
  "lib-dynamodb": "dynamodb",
  "client-api-gateway": "apigateway",
  "client-apigatewayv2": "apigateway",
  "client-cloudfront": "cloudfront",
  "client-route-53": "route53",
  "client-eks": "eks",
  "client-apprunner": "apprunner",
  "client-elastic-beanstalk": "elasticbeanstalk",
  "client-auto-scaling": "autoscaling",
  "client-sts": "sts",
  // the cloud map's coverage providers (and the catch-all)
  "client-acm": "acm",
  "client-amplify": "amplify",
  "client-application-auto-scaling": "application-autoscaling",
  "client-appsync": "appsync",
  "client-athena": "athena",
  "client-backup": "backup",
  "client-batch": "batch",
  "client-bedrock": "bedrock",
  "client-bedrock-agent": "bedrock",
  "client-bedrock-runtime": "bedrock",
  "client-cloudcontrol": "cloudformation",
  "client-cloudformation": "cloudformation",
  "client-cloudtrail": "cloudtrail",
  "client-codebuild": "codebuild",
  "client-codedeploy": "codedeploy",
  "client-codepipeline": "codepipeline",
  "client-cognito-identity-provider": "cognito-idp",
  "client-config-service": "config",
  "client-efs": "elasticfilesystem",
  "client-elastic-load-balancing": "elasticloadbalancing",
  "client-firehose": "firehose",
  "client-fsx": "fsx",
  "client-global-accelerator": "globalaccelerator",
  "client-glue": "glue",
  "client-iam": "iam",
  "client-kafka": "kafka",
  "client-kms": "kms",
  "client-lightsail": "lightsail",
  "client-memorydb": "memorydb",
  "client-mq": "mq",
  "client-network-firewall": "network-firewall",
  "client-opensearch": "es",
  "client-pipes": "pipes",
  "client-redshift": "redshift",
  "client-redshift-serverless": "redshift-serverless",
  "client-resource-explorer-2": "resource-explorer-2",
  "client-resource-groups-tagging-api": "tag",
  "client-route53resolver": "route53resolver",
  "client-sagemaker": "sagemaker",
  "client-scheduler": "scheduler",
  "client-servicediscovery": "servicediscovery",
  "client-sesv2": "ses",
  "client-synthetics": "synthetics",
  "client-transfer": "transfer",
  "client-vpc-lattice": "vpc-lattice",
  "client-wafv2": "wafv2",
};
// Commands whose IAM action isn't `<service>:<CommandName>`.
const OVERRIDES: Record<string, string> = {
  "lambda:Invoke": "lambda:InvokeFunction",
  "lambda:InvokeWithResponseStream": "lambda:InvokeFunction",
  "s3:ListBuckets": "s3:ListAllMyBuckets",
  "s3:ListObjects": "s3:ListBucket",
  "s3:ListObjectsV2": "s3:ListBucket",
  "s3:HeadBucket": "s3:ListBucket",
  "s3:HeadObject": "s3:GetObject",
  "s3:ListObjectVersions": "s3:ListBucketVersions",
  "s3:ListMultipartUploads": "s3:ListBucketMultipartUploads",
  "s3:DeleteObjects": "s3:DeleteObject",
  "s3:GetBucketNotificationConfiguration": "s3:GetBucketNotification",
  "s3:PutBucketNotificationConfiguration": "s3:PutBucketNotification",
  "s3:GetBucketEncryption": "s3:GetEncryptionConfiguration",
  "s3:GetPublicAccessBlock": "s3:GetBucketPublicAccessBlock",
  "s3:GetBucketCors": "s3:GetBucketCORS",
  "s3:GetBucketLifecycleConfiguration": "s3:GetLifecycleConfiguration",
  "s3:GetBucketReplication": "s3:GetReplicationConfiguration",
  "s3:GetBucketIntelligentTieringConfiguration": "s3:GetIntelligentTieringConfiguration",
  "s3:GetBucketMetricsConfiguration": "s3:GetMetricsConfiguration",
  "s3:GetBucketInventoryConfiguration": "s3:GetInventoryConfiguration",
  "s3:GetBucketAnalyticsConfiguration": "s3:GetAnalyticsConfiguration",
  "sqs:SendMessageBatch": "sqs:SendMessage",
  "sqs:DeleteMessageBatch": "sqs:DeleteMessage",
  "sqs:ChangeMessageVisibilityBatch": "sqs:ChangeMessageVisibility",
  "sns:PublishBatch": "sns:Publish",
  "dynamodb:BatchExecuteStatement": "dynamodb:PartiQLSelect",
  "dynamodb:ExecuteStatement": "dynamodb:PartiQLSelect",
  // Resource Explorer's ListResources is authorised by Search on the view; there is no ListResources IAM action (CC-1).
  "resource-explorer-2:ListResources": "resource-explorer-2:Search",
};
// API Gateway's control plane is authorised by HTTP verb. First match wins; REST and HTTP/WebSocket APIs differ a little.
const APIGW: Record<string, [RegExp, string][]> = {
  "client-api-gateway": [[/^(Get)/, "GET"], [/^(Create|Generate|Test|ImportRestApi$|ImportApiKeys$)/, "POST"], [/^(Put|Import|TagResource$)/, "PUT"], [/^Update/, "PATCH"], [/^(Delete|Flush|UntagResource$)/, "DELETE"]],
  "client-apigatewayv2": [[/^(Get|Export)/, "GET"], [/^(Create|TagResource$)/, "POST"], [/^(Import|Reimport)/, "PUT"], [/^Update/, "PATCH"], [/^(Delete|Reset|UntagResource$)/, "DELETE"]],
};
const NO_PERMISSION = new Set(["sts:GetCallerIdentity"]);

// aws.ts / billing-aws.ts (hand-written statements); every other SDK-importing file under SERVER is the cloud map's,
// except the agents' model adapters (connection credentials, not the console role — see the header).
const CONSOLE_SOURCES = ["src/lib/server/aws.ts", "src/lib/server/billing-aws.ts"];
const SERVER = "src/lib/server/";
const NOT_CONSOLE_ROLE = ["src/lib/server/agents/inference/", "src/lib/server/agents/runtime/", "src/lib/server/connection-credentials.ts"];
const WRITES = new Set([
  "ecs:UpdateService", "ecs:RegisterTaskDefinition", "ec2:StartInstances", "ec2:StopInstances", "rds:StartDBInstance", "rds:StopDBInstance",
  "ssm:PutParameter", "secretsmanager:PutSecretValue", "s3:PutObject",
  "ecs:CreateService", "ecs:DeleteService", "ecs:RunTask", "ec2:RunInstances", "ec2:TerminateInstances", "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup",
]);
// Reads of secret values belong only in the full policy: read-only users see variable names, never values. EC2 user
// data (read to launch a host like another) often holds secrets too. ssm:DescribeParameters is not one of them: it
// returns metadata only (name, type, tier, KMS key) and is a hand-written read in both policies.
const SENSITIVE = new Set(["ssm:GetParameter", "secretsmanager:GetSecretValue", "s3:GetObject", "ec2:DescribeInstanceAttribute"]);
// Authorised implicitly by the calls above rather than being SDK commands themselves.
const IMPLICIT = new Set(["iam:PassRole", "ecs:TagResource", "kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "ec2:CreateTags"]);

interface Call { file: string; pkg: string; command: string; action: string }

function actionFor(pkg: string, command: string, file: string): string {
  const verbs = APIGW[pkg];
  if (verbs) {
    const verb = verbs.find(([re]) => re.test(command))?.[1];
    assert.ok(verb, `${file}: no HTTP verb known for ${command}Command (@aws-sdk/${pkg}) — add it to APIGW in src/lib/iam-policy.test.ts`);
    return `apigateway:${verb}`;
  }
  const svc = SERVICE[pkg];
  assert.ok(svc, `${file} imports @aws-sdk/${pkg} — add it to SERVICE in src/lib/iam-policy.test.ts (package → IAM service prefix)`);
  const a = `${svc}:${command}`;
  return OVERRIDES[a] ?? a;
}

function callsIn(file: string, src: string): Call[] {
  const out: Call[] = [];
  let named = 0;
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@aws-sdk\/([a-z0-9-]+)["']/g)) {
    const pkg = m[3];
    if (!pkg.startsWith("client-") && pkg !== "lib-dynamodb") continue; // credential providers, signers…
    named++;
    if (m[1]) continue; // import type { … }
    for (const raw of m[2].split(",")) {
      const name = raw.trim().replace(/\s+as\s+\w+$/, "");
      if (!name || name.startsWith("type ")) continue;
      const command = /^([A-Z]\w*)Command$/.exec(name)?.[1] ?? /^paginate([A-Z]\w*)$/.exec(name)?.[1];
      if (command) out.push({ file, pkg, command, action: actionFor(pkg, command, file) });
    }
  }
  const all = [...src.matchAll(/from\s*["']@aws-sdk\/(client-[a-z0-9-]+|lib-dynamodb)["']|import\(\s*["']@aws-sdk\/(client-[a-z0-9-]+|lib-dynamodb)["']\s*\)/g)].length;
  assert.equal(all, named, `${file}: import AWS SDK commands by name (import { ListQueuesCommand } from "@aws-sdk/client-sqs") so this test can map them to IAM actions`);
  return out;
}

async function serverFiles(): Promise<string[]> {
  const entries = await readdir(new URL(SERVER, root), { recursive: true });
  return entries.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => SERVER + f.split("\\").join("/")).sort();
}
const consoleRole = (f: string) => !NOT_CONSOLE_ROLE.some((d) => f.startsWith(d));

let callsP: Promise<{ consoleCalls: Call[]; providerCalls: Call[]; sources: Map<string, string> }> | undefined;
function calls() {
  callsP ??= (async () => {
    const sources = new Map<string, string>();
    for (const f of (await serverFiles()).filter(consoleRole)) {
      const src = await read(f);
      if (CONSOLE_SOURCES.includes(f) || /["']@aws-sdk\/(client-|lib-dynamodb)/.test(src)) sources.set(f, src);
    }
    const consoleCalls = CONSOLE_SOURCES.flatMap((f) => callsIn(f, sources.get(f)!));
    const providerCalls = [...sources.keys()].filter((f) => !CONSOLE_SOURCES.includes(f)).flatMap((f) => callsIn(f, sources.get(f)!));
    return { consoleCalls, providerCalls, sources };
  })();
  return callsP;
}

// The registry, loaded like `npm run iam:policy -- --json` does (plain node --test can't import server-only modules).
let declsP: Promise<Declaration[]> | undefined;
function declarations(): Promise<Declaration[]> {
  declsP ??= (async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // the child is a script, not a test file
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "scripts/iam-policy.mjs", "--json"], { cwd: fileURLToPath(root), env, timeout: 90_000, maxBuffer: 32 << 20 });
      return (JSON.parse(stdout) as { providers: Declaration[] }).providers;
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`couldn't load the provider registry (npm run iam:policy -- --json). Provider files must be importable by Node: relative .ts imports, no "@/" aliases.\n${err.stderr || err.message}`);
    }
  })();
  return declsP;
}

const classOf = (d: Declaration, a: string) =>
  d.read.includes(a) ? "read" : d.sensitive?.includes(a) ? "sensitive" : d.write?.includes(a) ? "write" : d.implicit?.includes(a) ? implicitClass(a) : undefined;
// Every IAM action the providers need, by class (implicit ones classed like the generator does).
function providerClasses(decls: Declaration[]) {
  const by = { read: new Set<string>(), sensitive: new Set<string>(), write: new Set<string>(), implicit: new Set<string>() };
  for (const d of decls) {
    for (const a of d.read.filter(isIamAction)) by.read.add(a);
    for (const a of (d.sensitive ?? []).filter(isIamAction)) by.sensitive.add(a);
    for (const a of (d.write ?? []).filter(isIamAction)) by.write.add(a);
    for (const a of (d.implicit ?? []).filter(isIamAction)) {
      by.implicit.add(a);
      by[implicitClass(a)].add(a);
    }
  }
  return by;
}

type Statement = PolicyDocument["Statement"][number];
async function policy(file: string): Promise<PolicyDocument> {
  return JSON.parse(await read(file)) as PolicyDocument;
}
function granted(doc: PolicyDocument): { allow: Set<string>; deny: Set<string> } {
  const allow = new Set<string>(), deny = new Set<string>();
  for (const s of doc.Statement as Statement[]) for (const a of [s.Action ?? []].flat()) (s.Effect === "Allow" ? allow : deny).add(a);
  return { allow, deny };
}
const fmt = (xs: Iterable<string>) => [...new Set(xs)].sort();

test("every AWS call a provider makes is declared, and every declared action is called", async () => {
  const [{ consoleCalls, providerCalls, sources }, decls] = await Promise.all([calls(), declarations()]);
  const problems: string[] = [];
  const declared = new Set(decls.flatMap((d) => [...d.read, ...(d.sensitive ?? []), ...(d.write ?? [])]));
  for (const c of providerCalls) {
    if (NO_PERMISSION.has(c.action) || declared.has(c.action)) continue;
    const ids = fmt([...(sources.get(c.file) ?? "").matchAll(/\bid:\s*"([a-z0-9-]+)"\s*,\s*label:[^}]{0,600}?\bread\b/g)].map((m) => m[1]));
    problems.push(`${c.file}: ${c.command} (@aws-sdk/${c.pkg}) needs "${c.action}" — add it to the \`read\` (discovery), \`sensitive\` (reads data) or \`write\` (actions) list of the provider that calls it${ids.length ? ` (providers in this file: ${ids.join(", ")})` : ""}`);
  }

  const used = new Set([...consoleCalls, ...providerCalls].map((c) => c.action));
  for (const d of decls)
    for (const a of [...d.read, ...(d.sensitive ?? []), ...(d.write ?? [])])
      if (isIamAction(a) && !used.has(a)) problems.push(`${d.id}: declares "${a}" but no AWS source calls it — remove it, or move it to \`implicit\` if another call needs it`);

  const byAction = new Map<string, Set<string>>();
  for (const d of decls)
    for (const a of [...d.read, ...(d.sensitive ?? []), ...(d.write ?? []), ...(d.implicit ?? [])].filter(isIamAction)) {
      if (!byAction.has(a)) byAction.set(a, new Set());
      byAction.get(a)!.add(`${d.id}:${classOf(d, a)}`);
    }
  for (const [a, where] of byAction) if (new Set([...where].map((w) => w.split(":")[1])).size > 1) problems.push(`"${a}" is ${fmt(where).join(" / ")} — an action has one class: pick one`);
  for (const a of providerClasses(decls).read)
    if (WRITES.has(a) || SENSITIVE.has(a)) problems.push(`"${a}" is declared as a read, but the console treats it as ${WRITES.has(a) ? "a write" : "a sensitive read"} — move it to \`${WRITES.has(a) ? "write" : "sensitive"}\``);
  assert.deepEqual(fmt(problems), [], "provider declarations don't match the AWS calls");
});

test("the Inventory statements are what npm run iam:policy generates", async () => {
  const decls = await declarations();
  for (const [file, mode] of [["infra/iam-policy-readonly.json", "read"], ["infra/iam-policy.json", "full"]] as const) {
    const doc = await policy(file);
    const firstGenerated = doc.Statement.findIndex(isGenerated);
    if (firstGenerated >= 0) assert.ok(doc.Statement.slice(firstGenerated).every(isGenerated), `${file}: hand-written statements come before the Inventory* ones`);
    const { policy: want } = buildPolicy(decls, mode, baseStatements(doc));
    assert.deepEqual(doc, want, `${file} is out of date — run npm run iam:policy`);
  }
});

test("the full policy grants exactly the AWS actions the console calls", async () => {
  const [{ consoleCalls, providerCalls }, decls] = await Promise.all([calls(), declarations()]);
  const used = new Set([...consoleCalls, ...providerCalls].map((c) => c.action).filter((a) => !NO_PERMISSION.has(a)));
  const byClass = providerClasses(decls);
  const { allow, deny } = granted(await policy("infra/iam-policy.json"));
  assert.deepEqual([...used].filter((a) => !allow.has(a)).sort(), [], "used but not granted — run npm run iam:policy (provider calls) or add a hand-written statement (aws.ts)");
  assert.deepEqual(
    [...byClass.implicit].filter((a) => !allow.has(a)).map((a) => `${a}${handWrittenOnly(a) ? " — iam:* and kms:* need a hand-written statement with a condition (iam:PassedToService, kms:ViaService) in infra/iam-policy.json" : ""}`).sort(),
    [],
    "a provider's implicit action isn't granted",
  );
  assert.deepEqual([...allow].filter((a) => !used.has(a) && !IMPLICIT.has(a) && !byClass.implicit.has(a)).sort(), [], "granted but never used");
  assert.deepEqual(
    [...deny].sort(),
    [
      "autoscaling:SetDesiredCapacity", "ec2:RebootInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ecs:CreateService", "ecs:DeleteService", "ecs:RunTask", "ecs:UpdateService", "iam:PassRole",
      "s3:DeleteObject", "s3:GetObject", "s3:PutObject", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "ssm:GetParameter", "ssm:PutParameter",
    ],
    "the console may never change, copy, run, stop or scale itself, pass its own role, or read or write its own configuration",
  );
});

// F34 backstop: the console's own parameters, secrets and env file stay out of reach even if the shared-reference
// check in the Variables editor (envvars.ts) were wrong. ECS hands the console its secrets through the execution role,
// so denying them to the task role costs nothing. Region "*": the denies hold in every region the console reads.
test("the full policy denies the console's own parameters, secrets and env file (F34)", async () => {
  const doc = await policy("infra/iam-policy.json");
  const denies = new Map(doc.Statement.filter((s) => s.Effect === "Deny").map((s) => [[s.Action ?? []].flat().sort().join(" "), s.Resource]));
  assert.equal(denies.get("ssm:GetParameter ssm:PutParameter"), "arn:aws:ssm:*:ACCOUNT_ID:parameter/CONSOLE_PARAM_PREFIX/*");
  assert.equal(denies.get("secretsmanager:GetSecretValue secretsmanager:PutSecretValue"), "arn:aws:secretsmanager:*:ACCOUNT_ID:secret:CONSOLE_SECRET_PREFIX*");
  assert.equal(denies.get("s3:DeleteObject s3:GetObject s3:PutObject"), "arn:aws:s3:::ENV_FILES_BUCKET/CONSOLE_ENV_FILE");
  // Each placeholder the full policy uses is documented for whoever fills it in.
  const connect = await read("docs/connect-aws.md");
  for (const p of placeholdersIn(doc)) assert.ok(connect.includes(`\`${p}\``), `docs/connect-aws.md doesn't explain the placeholder ${p}`);
  // kms:ViaService is region-scoped through REGION only, so forRegions() can widen it for a multi-region console.
  const via = doc.Statement.flatMap((s) => [s.Condition?.StringLike?.["kms:ViaService"] ?? []].flat());
  assert.ok(via.length > 0 && via.every((v) => /^[a-z0-9-]+\.REGION\.amazonaws\.com$/.test(v)), via.join(", "));
  const wide = forRegions(doc, ["us-east-1", "eu-west-1"]);
  assert.ok(wide.Statement.flatMap((s) => [s.Condition?.StringLike?.["kms:ViaService"] ?? []].flat()).every((v) => /^[a-z0-9-]+\.\*\.amazonaws\.com$/.test(v)));
  assert.ok(!placeholdersIn(wide).includes("REGION"), "no REGION left for a multi-region console");
});

test("SimulateOwnPermissions: both policies let the console simulate only its own principal (F06)", async () => {
  for (const file of ["infra/iam-policy-readonly.json", "infra/iam-policy.json"]) {
    const doc = await policy(file);
    const sim = doc.Statement.filter((s) => [s.Action ?? []].flat().includes("iam:SimulatePrincipalPolicy"));
    assert.deepEqual(sim.map((s) => [s.Sid, s.Effect, s.Resource]), [[SIMULATE_SID, "Allow", "arn:aws:iam::ACCOUNT_ID:role/deployment-console-task"]], file);
    const user = withPrincipal(doc, "arn:aws:iam::123456789012:user/deployment-console-local");
    assert.equal(user.Statement.find((s) => s.Sid === SIMULATE_SID)?.Resource, "arn:aws:iam::123456789012:user/deployment-console-local");
  }
});

test("the read-only policy grants every read and no write", async () => {
  const [{ consoleCalls }, decls] = await Promise.all([calls(), declarations()]);
  const byClass = providerClasses(decls);
  const consoleReads = consoleCalls.map((c) => c.action).filter((a) => !WRITES.has(a) && !SENSITIVE.has(a) && !NO_PERMISSION.has(a));
  const reads = new Set([...consoleReads, ...byClass.read]);
  const notRead = new Set([...WRITES, ...SENSITIVE, ...byClass.sensitive, ...byClass.write]);
  const { allow, deny } = granted(await policy("infra/iam-policy-readonly.json"));
  assert.deepEqual([...reads].filter((a) => !allow.has(a)).sort(), [], "read used but not granted — run npm run iam:policy");
  assert.deepEqual([...allow].filter((a) => notRead.has(a) || !reads.has(a)).sort(), [], "write, sensitive read or unused action granted");
  assert.deepEqual([...deny], [], "the read-only policy needs no denies");
});

test("docs explain every granted action", async () => {
  const [{ consoleCalls, providerCalls }, decls] = await Promise.all([calls(), declarations()]);
  const connect = await read("docs/connect-aws.md");
  const missing = fmt(consoleCalls.map((c) => c.action)).filter((a) => !connect.includes(`\`${a}\``));
  assert.deepEqual(missing, [], "add these to the tables of docs/connect-aws.md");
  const services = await read("docs/services.md");
  assert.equal(services, withDocsSection(services, decls), "docs/services.md's generated table is out of date — run npm run iam:policy");
  const listed = fmt(providerCalls.map((c) => c.action)).filter((a) => !NO_PERMISSION.has(a) && !services.includes(`\`${a}\``));
  assert.deepEqual(listed, [], "provider actions missing from docs/services.md — run npm run iam:policy");
});

test("the Bedrock runtime client (model calls) is only imported by the agents' model adapters", async () => {
  const offenders: string[] = [];
  const scan = async (dir: string) => {
    for (const f of await readdir(new URL(dir, root), { recursive: true })) {
      const path = dir + f.split("\\").join("/");
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(path) || !consoleRole(path)) continue;
      if (/["']@aws-sdk\/client-bedrock-runtime["']/.test(await read(path))) offenders.push(path);
    }
  };
  await scan("src/");
  await scan("scripts/");
  assert.deepEqual(offenders, [], "model calls use a connection's credentials: keep them in src/lib/server/agents/inference/ or runtime/");
});

// `covers` (Resource Explorer types) is checked in src/lib/inventory/covers.test.ts.
test("every provider's kinds exist, and only their owner provider sets facts on them", async () => {
  const decls = await declarations();
  const problems: string[] = [];
  for (const d of decls)
    for (const k of d.kinds ?? []) {
      if (!Object.hasOwn(KIND_INFO, k)) problems.push(`${d.id}: kind "${k}" isn't in KIND_INFO`);
      else if (KIND_INFO[k].provider && KIND_INFO[k].provider !== d.id) problems.push(`${d.id}: kind "${k}" belongs to ${KIND_INFO[k].provider} (KIND_INFO), and only its owner sets facts on it (CC-5)`);
    }
  for (const [kind, info] of Object.entries(KIND_INFO))
    if (info.provider && !decls.some((d) => d.id === info.provider)) problems.push(`KIND_INFO["${kind}"].provider "${info.provider}" isn't a registered provider`);
  assert.deepEqual(problems, []);
});

// F67: the graceful stop (src/instrumentation.ts) only runs when Next leaves SIGTERM to the console, and needs about
// 25 s to finish changes in flight; the shipped deployment files must keep both. The compose file is for one machine:
// it publishes on loopback only.
test("deployment settings keep the graceful stop and a loopback-only compose port (F67)", async () => {
  const docker = await read("Dockerfile");
  assert.match(docker, /^ENV NEXT_MANUAL_SIG_HANDLE=true$/m);
  assert.match(docker, /^ENTRYPOINT \["\/sbin\/tini", "--"\]$/m, "tini as PID 1 forwards the signal");
  const td = JSON.parse(await read("infra/task-definition.json")) as { containerDefinitions: { stopTimeout?: number; environment?: { name: string; value: string }[] }[] };
  const c = td.containerDefinitions[0];
  assert.ok((c.stopTimeout ?? 0) >= 30, `stopTimeout ${c.stopTimeout}`);
  assert.equal(c.environment?.find((e) => e.name === "NEXT_MANUAL_SIG_HANDLE")?.value, "true");
  const compose = await read("docker-compose.yml");
  const grace = /stop_grace_period:\s*(\d+)s/.exec(compose);
  assert.ok(grace && Number(grace[1]) >= 30, "stop_grace_period ≥ 30s");
  const ports = [...compose.matchAll(/^\s*-\s*"([^"]*:\d+)"\s*$/gm)].map((m) => m[1]);
  assert.ok(ports.length > 0 && ports.every((p) => p.startsWith("127.0.0.1:")), `published on loopback only: ${ports.join(", ")}`);
});

// Every AWS SDK package stays a runtime require (next.config.ts serverExternalPackages) instead of being bundled into
// every route, and the proxy body cap (F64) and HSTS (F65) stay configured.
test("next.config.ts: every @aws-sdk dependency is external; the body cap and HSTS are set (F64, F65)", async () => {
  const pkg = JSON.parse(await read("package.json")) as { dependencies: Record<string, string> };
  const cfg = await read("next.config.ts");
  const listed = new Set([...cfg.matchAll(/"(@aws-sdk\/[a-z0-9-]+)"/g)].map((m) => m[1]));
  const deps = Object.keys(pkg.dependencies).filter((d) => d.startsWith("@aws-sdk/"));
  assert.deepEqual(deps.filter((d) => !listed.has(d)), [], "add these to serverExternalPackages in next.config.ts");
  assert.deepEqual([...listed].filter((d) => !deps.includes(d)), [], "listed in next.config.ts but not a dependency");
  assert.match(cfg, /proxyClientMaxBodySize:\s*"13mb"/);
  assert.match(cfg, /Strict-Transport-Security", value: "max-age=31536000; includeSubDomains"/);
});
