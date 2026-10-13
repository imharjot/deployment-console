import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { expiresAt, ssmDetail, ssmResult, type RawParameter } from "./ssm.ts";
import { simSsm } from "../server/providers/mock/ssm.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const SENTINEL = "SENTINEL-ssm-0b77e4";
const expiration = (ts: string) => ({ PolicyType: "Expiration", PolicyStatus: "Pending", PolicyText: JSON.stringify({ Type: "Expiration", Version: "1.0", Attributes: { Timestamp: ts } }) });

// Golden: DescribeParameters metadata. DescribeParameters returns no value; the sentinel sits in a Value field (as
// GetParameter would return it) to prove the mapper copies named metadata only.
const GOLDEN: RawParameter[] = [
  { Name: "/acme/production/api/JWT_SIGNING_KEY", ARN: `arn:aws:ssm:${R}:${A}:parameter/acme/production/api/JWT_SIGNING_KEY`, Type: "SecureString", KeyId: "alias/acme-production", Tier: "Standard", Version: 4, LastModifiedDate: new Date("2026-09-01T10:00:00Z"), LastModifiedUser: `arn:aws:iam::${A}:user/ci`, Value: SENTINEL } as RawParameter,
  { Name: "/acme/feature-flags", Type: "StringList", Tier: "Standard", Version: 1, Policies: [expiration("2026-10-01T00:00:00.000Z")] },
  { Name: "plain-name", Type: "SecureString", Policies: [expiration("2027-01-01T00:00:00.000Z")] }, // no ARN, default key
  { Name: "/acme/ami", Type: "String", DataType: "aws:ec2:image", Policies: [{ PolicyType: "Expiration", PolicyText: "{not json" }] },
];
const result = () => ssmResult(GOLDEN, { region: R, account: A, now: NOW });
const byName = (n: string) => result().resources.find((r) => r.name === n)!;

test("ssm: key via arnOf (no doubled slash), alias the stored name, tags unread", () => {
  assert.equal(byName("/acme/feature-flags").key, `arn:aws:ssm:${R}:${A}:parameter/acme/feature-flags`);
  assert.equal(byName("plain-name").key, `arn:aws:ssm:${R}:${A}:parameter/plain-name`);
  assert.deepEqual(byName("/acme/feature-flags").aliases, ["/acme/feature-flags"]);
  for (const r of result().resources) assert.equal(r.tagsUnread, true);
  assert.equal(byName("/acme/production/api/JWT_SIGNING_KEY").props.find((p) => p.label === "Last modified")?.value, "2026-09-01 10:00 UTC by ci");
  assert.equal(byName("/acme/ami").props.find((p) => p.label === "Data type")?.value, "aws:ec2:image");
});

test("ssm: KMS → SecureString (encrypts), the default alias/aws/ssm when no KeyId", () => {
  const l = result().links;
  assert.deepEqual(l.map((x) => [x.from, x.to, x.kind]), [
    [`arn:aws:kms:${R}:${A}:alias/acme-production`, `arn:aws:ssm:${R}:${A}:parameter/acme/production/api/JWT_SIGNING_KEY`, "encrypts"],
    [`arn:aws:kms:${R}:${A}:alias/aws/ssm`, `arn:aws:ssm:${R}:${A}:parameter/plain-name`, "encrypts"],
  ]);
});

test("ssm: an Expiration policy in the past warns; unreadable policies are ignored", () => {
  assert.equal(byName("/acme/feature-flags").health, "warning");
  assert.match(byName("/acme/feature-flags").healthReason ?? "", /^expired on 2026-10-01/);
  assert.equal(byName("plain-name").health, "ok");
  assert.equal(expiresAt(GOLDEN[3]), undefined);
});

test("ssm: no secret sentinel in resources or detail; detail shows tags or says they weren't read", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  const d = ssmDetail(GOLDEN[0].ARN!, GOLDEN[0], [{ Key: "Environment", Value: "production" }]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.deepEqual(d.sections.at(-1)?.table?.rows, [["Environment", "production"]]);
  assert.equal(ssmDetail("k", GOLDEN[1], undefined).sections.at(-1)?.note, "Not read.");
});

test("ssm: the Acme simulation — the ECS services' JWT keys, keyed like their valueFrom, per region", () => {
  const home = ssmResult(simSsm("us-east-1", NOW), { region: "us-east-1", account: A, now: NOW });
  assert.deepEqual(home.resources.map((r) => r.key), ["api", "worker", "billing"].map((s) => `arn:aws:ssm:us-east-1:${A}:parameter/acme/production/${s}/JWT_SIGNING_KEY`));
  assert.equal(home.links.length, 3);
  const eu = ssmResult(simSsm("eu-west-1", NOW), { region: "eu-west-1", account: A, now: NOW });
  assert.deepEqual(eu.resources.map((r) => r.key), ["api", "worker"].map((s) => `arn:aws:ssm:eu-west-1:${A}:parameter/acme/production-eu/${s}/JWT_SIGNING_KEY`));
  assert.deepEqual(simSsm("ap-south-1", NOW), []);
});

// The provider's I/O: DescribeParameters as a read, 50 per page, stopping at 2,000 per region even when the run's cap
// is higher; never GetParameter(s). providers/ssm.ts imports "server-only": child process, react-server condition, the
// SDK's send() faked.
test("ssm provider: DescribeParameters 50 per page, capped at 2,000; no other discovery call", () => {
  const provider = new URL("../server/providers/ssm.ts", import.meta.url).href;
  const script = `
    const { SSMClient } = await import("@aws-sdk/client-ssm");
    const calls = [];
    SSMClient.prototype.send = async function (cmd) {
      const op = cmd.constructor.name.replace(/Command$/, ""), i = cmd.input;
      calls.push([op, i.MaxResults ?? null]);
      if (op !== "DescribeParameters") throw new Error("unexpected " + op);
      const page = Number(i.NextToken ?? 0);
      return { Parameters: Array.from({ length: 50 }, (_, n) => ({ Name: "/p/" + (page * 50 + n), Type: "String" })), NextToken: String(page + 1) };
    };
    const { ssmProvider } = await import(${JSON.stringify(provider)});
    const notes = [];
    const ctx = { region: "${R}", accountId: "${A}", mock: false, cap: 5000, signal: new AbortController().signal, limit: (fn) => fn(), note: (m) => notes.push(m) };
    const r = await ssmProvider.discover(ctx);
    process.stdout.write(JSON.stringify({ ops: [...new Set(calls.map((c) => c.join(":")))], pages: calls.length, count: r.resources.length, notes }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  assert.deepEqual(out.ops, ["DescribeParameters:50"]);
  assert.equal(out.pages, 40);
  assert.equal(out.count, 2000);
  assert.deepEqual(out.notes, ["ssm parameters: showing the first 2,000"]);
});
