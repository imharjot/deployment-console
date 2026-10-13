import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { secretsDetail, secretsResult, type RawSecret } from "./secrets.ts";
import { simSecrets } from "../server/providers/mock/secrets.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const SENTINEL = "SENTINEL-secret-c48a17";
const arn = (nameWithSuffix: string) => `arn:aws:secretsmanager:${R}:${A}:secret:${nameWithSuffix}`;
const ROTATOR = `arn:aws:lambda:${R}:${A}:function:rotate-db`;

// Golden: ListSecrets entries. ListSecrets has no value field; the sentinel sits in fields a value could only reach by
// mistake (SecretString, a stray property) to prove the mapper copies named metadata only.
const GOLDEN: RawSecret[] = [
  {
    ARN: arn("prod/api-key123-Ab12Cd"), Name: "prod/api-key123", Description: "Stripe key", KmsKeyId: `arn:aws:kms:${R}:${A}:key/k-app`,
    RotationEnabled: true, RotationLambdaARN: ROTATOR, RotationRules: { AutomaticallyAfterDays: 30 }, LastRotatedDate: new Date(NOW - 10 * DAY), NextRotationDate: new Date(NOW + 20 * DAY),
    LastAccessedDate: new Date("2026-10-05T00:00:00Z"), Tags: [{ Key: "Environment", Value: "production" }], SecretVersionsToStages: { v1: ["AWSCURRENT"] },
    SecretString: SENTINEL, extra: { value: SENTINEL },
  } as RawSecret,
  { ARN: arn("legacy/smtp-9xYz01"), Name: "legacy/smtp", DeletedDate: new Date("2026-10-01T08:00:00Z"), Tags: [] },
  { ARN: arn("db/rotating-QwErTy"), Name: "db/rotating", KmsKeyId: "alias/app", RotationEnabled: true, RotationLambdaARN: ROTATOR, NextRotationDate: new Date(NOW - 3 * DAY) },
  { ARN: arn("db/by-rule-AaBbCc"), Name: "db/by-rule", RotationEnabled: true, RotationRules: { AutomaticallyAfterDays: 7 }, LastRotatedDate: new Date(NOW - 9 * DAY) },
  { ARN: arn("rds!db-0acme-1A2b3C"), Name: "rds!db-0acme", OwningService: "rds", RotationEnabled: true, NextRotationDate: new Date(NOW - DAY / 2) },
];
const result = () => secretsResult(GOLDEN, { now: NOW });
const byName = (n: string) => result().resources.find((r) => r.name === n)!;

test("secrets: key is the full ARN; the partial-ARN alias is computed from the name, never by stripping a suffix", () => {
  const s = byName("prod/api-key123");
  assert.equal(s.key, arn("prod/api-key123-Ab12Cd"));
  assert.deepEqual(s.aliases, ["prod/api-key123", arn("prod/api-key123")]);
  assert.ok(!s.aliases?.includes(arn("prod/api")), "a name ending in -key123 keeps its tail");
  assert.deepEqual(s.tags, { Environment: "production" });
  assert.equal(s.tagsUnread, undefined);
  assert.equal(s.lastActivityAt, Date.parse("2026-10-05T00:00:00Z"));
  assert.equal(s.props.find((p) => p.label === "Rotation")?.value, "every 30 days (next 2026-10-25)");
});

test("secrets: rotation Lambda (invoke) and KMS (encrypts) links, defaulting to alias/aws/secretsmanager", () => {
  const l = result().links;
  assert.ok(l.some((x) => x.from === arn("prod/api-key123-Ab12Cd") && x.to === ROTATOR && x.kind === "invoke"));
  assert.ok(l.some((x) => x.to === arn("prod/api-key123-Ab12Cd") && x.from === `arn:aws:kms:${R}:${A}:key/k-app` && x.kind === "encrypts"));
  assert.ok(l.some((x) => x.to === arn("db/rotating-QwErTy") && x.from === `arn:aws:kms:${R}:${A}:alias/app`), "a bare alias becomes the region's alias ARN");
  assert.ok(l.some((x) => x.to === arn("legacy/smtp-9xYz01") && x.from === `arn:aws:kms:${R}:${A}:alias/aws/secretsmanager` && x.kind === "encrypts"));
});

test("secrets: scheduled deletion is an error (facts.state for R5); rotation overdue by more than a day warns", () => {
  assert.equal(byName("legacy/smtp").health, "error");
  assert.match(byName("legacy/smtp").healthReason ?? "", /scheduled for deletion \(requested 2026-10-01/);
  assert.deepEqual(byName("legacy/smtp").facts, { state: "PendingDeletion" });
  assert.deepEqual([byName("db/rotating").health, byName("db/rotating").healthReason], ["warning", "rotation overdue since 2026-10-02"]);
  assert.equal(byName("db/by-rule").health, "warning", "last rotation + schedule when NextRotationDate is missing");
  assert.equal(byName("rds!db-0acme").health, "ok", "less than a day late is not overdue");
  assert.equal(byName("rds!db-0acme").props.find((p) => p.label === "Managed by")?.value, "rds");
  assert.equal(byName("prod/api-key123").health, "ok");
});

test("secrets: no secret sentinel anywhere — resources, links, detail", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  const d = secretsDetail(GOLDEN[0].ARN!, GOLDEN[0]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.deepEqual(d.sections.map((s) => s.title), ["Secret", "Versions", "Tags"]);
});

test("secrets: the Acme simulation — one secret per production service in us-east-1, none elsewhere", () => {
  const r = secretsResult(simSecrets("us-east-1", NOW), { now: NOW });
  assert.deepEqual(r.resources.map((x) => [x.name, x.health]), [["acme/production/api", "ok"], ["acme/production/worker", "ok"], ["acme/production/billing", "ok"]]);
  assert.deepEqual(r.resources[0].aliases, ["acme/production/api", `arn:aws:secretsmanager:${R}:${A}:secret:acme/production/api`]);
  assert.equal(r.links.filter((l) => l.kind === "encrypts").length, 3);
  assert.deepEqual(simSecrets("eu-west-1", NOW), []);
});

// The provider's I/O: ListSecrets (IncludePlannedDeletion, 100 per page) is the only discovery call; DescribeSecret
// runs in detail() only, and a secret deleted since then shows as gone. providers/secrets.ts imports "server-only":
// child process, react-server condition, the SDK's send() faked.
test("secrets provider: ListSecrets with IncludePlannedDeletion, 100 per page; DescribeSecret in detail() only", () => {
  const provider = new URL("../server/providers/secrets.ts", import.meta.url).href;
  const script = `
    const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
    const calls = [];
    SecretsManagerClient.prototype.send = async function (cmd) {
      const op = cmd.constructor.name.replace(/Command$/, ""), i = cmd.input;
      calls.push([op, i.IncludePlannedDeletion ?? null, i.MaxResults ?? null, i.NextToken ?? null]);
      if (op === "ListSecrets") return i.NextToken ? { SecretList: [{ ARN: "${arn("b-Zz9Yy8")}", Name: "b" }] } : { SecretList: [{ ARN: "${arn("a-Xx1Yy2")}", Name: "a" }], NextToken: "t1" };
      if (op === "DescribeSecret") throw Object.assign(new Error("Secrets Manager can't find the specified secret."), { name: "ResourceNotFoundException" });
      throw new Error("unexpected " + op);
    };
    const { secretsProvider } = await import(${JSON.stringify(provider)});
    const ctx = { region: "${R}", accountId: "${A}", mock: false, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: () => {} };
    const r = await secretsProvider.discover(ctx);
    const listed = calls.length;
    const d = await secretsProvider.detail(r.resources[0], ctx);
    process.stdout.write(JSON.stringify({ calls, listed, names: r.resources.map((x) => x.name), detail: d }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  assert.deepEqual(out.calls.slice(0, out.listed), [["ListSecrets", true, 100, null], ["ListSecrets", true, 100, "t1"]]);
  assert.deepEqual(out.names, ["a", "b"]);
  assert.deepEqual(out.calls.slice(out.listed).map((c: unknown[]) => c[0]), ["DescribeSecret"]);
  assert.equal(out.detail.sections[0].note, "This secret no longer exists.");
});
