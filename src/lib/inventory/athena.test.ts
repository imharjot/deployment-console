import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { athenaDetail, athenaResult, bucketArnOf, type AthenaConfig, type RawWorkGroup } from "./athena.ts";
import { simAthena } from "../server/providers/mock/athena.ts";

const R = "us-east-1";
const A = "123456789012";
const SENTINEL = "SENTINEL-athena-5e2d90";
const KEY = `arn:aws:kms:${R}:${A}:key/k-app`;
const ROLE = `arn:aws:iam::${A}:role/spark-exec`;

// Golden: ListWorkGroups summaries plus GetWorkGroup configurations. Spark properties (AdditionalConfiguration) may hold
// credentials; they carry the sentinel and must never be copied.
const GOLDEN: RawWorkGroup[] = [
  { Name: "primary", State: "ENABLED", enrichment: { config: "ok" }, config: { ResultConfiguration: {} } },
  {
    Name: "analysts", State: "ENABLED", Description: "ad hoc", enrichment: { config: "ok" },
    config: { ResultConfiguration: { OutputLocation: "s3://acme-lake/results/", EncryptionConfiguration: { EncryptionOption: "SSE_KMS", KmsKey: KEY } }, EnforceWorkGroupConfiguration: true, BytesScannedCutoffPerQuery: 1024 ** 3, EngineVersion: { EffectiveEngineVersion: "Athena engine version 3" } },
  },
  { Name: "spark", State: "DISABLED", enrichment: { config: "ok" }, config: { ExecutionRole: ROLE, CustomerContentEncryptionConfiguration: { KmsKey: "alias/spark" }, AdditionalConfiguration: `{"spark.secret":"${SENTINEL}"}` } as AthenaConfig },
  { Name: "denied", State: "ENABLED", enrichment: { config: "denied" } },
];
const result = () => athenaResult(GOLDEN, { region: R, account: A });
const byName = (n: string) => result().resources.find((r) => r.name === n)!;

test("athena: keys, the default primary hidden without a result location, health from State", () => {
  assert.equal(byName("analysts").key, `arn:aws:athena:${R}:${A}:workgroup/analysts`);
  assert.equal(byName("primary").hidden, true);
  assert.equal(byName("analysts").hidden, undefined);
  assert.equal(byName("analysts").health, "ok");
  assert.deepEqual([byName("spark").health, byName("spark").healthReason], ["stopped", "disabled — queries can't run in it"]);
  assert.equal(byName("denied").props.find((p) => p.label === "Query results")?.value, "configuration not read (denied)");
  for (const r of result().resources) assert.equal(r.tagsUnread, true);
  const usedPrimary = athenaResult([{ Name: "primary", State: "ENABLED", config: { ResultConfiguration: { OutputLocation: "s3://b/x/" } } }], { region: R, account: A }).resources[0];
  assert.equal(usedPrimary.hidden, undefined, "a primary that writes results is shown");
});

test("athena: output bucket (writes), KMS (encrypts) and execution role (assumes) links", () => {
  assert.deepEqual(result().links.map((l) => [l.from, l.to, l.kind]), [
    [`arn:aws:athena:${R}:${A}:workgroup/analysts`, "arn:aws:s3:::acme-lake", "writes"],
    [KEY, `arn:aws:athena:${R}:${A}:workgroup/analysts`, "encrypts"],
    [`arn:aws:kms:${R}:${A}:alias/spark`, `arn:aws:athena:${R}:${A}:workgroup/spark`, "encrypts"],
    [`arn:aws:athena:${R}:${A}:workgroup/spark`, ROLE, "assumes"],
  ]);
  assert.equal(bucketArnOf("s3://acme-lake", "cn-north-1"), "arn:aws-cn:s3:::acme-lake");
  assert.equal(bucketArnOf("https://example.com/x", R), undefined);
});

test("athena: no secret sentinel in resources or detail", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  assert.ok(!JSON.stringify(athenaDetail("k", GOLDEN[2])).includes(SENTINEL));
  assert.equal(athenaDetail("k", GOLDEN[1]).sections[0].rows?.find((r) => r.label === "Query results")?.value, "s3://acme-lake/results/");
});

test("athena: the Acme simulation — a hidden primary in each region, acme-analysts writing to the lake at home", () => {
  const home = athenaResult(simAthena("us-east-1"), { region: "us-east-1", account: A });
  assert.deepEqual(home.resources.map((r) => [r.name, !!r.hidden]), [["primary", true], ["acme-analysts", false]]);
  assert.ok(home.links.some((l) => l.to === "arn:aws:s3:::acme-data-lake" && l.kind === "writes"));
  const eu = athenaResult(simAthena("eu-west-1"), { region: "eu-west-1", account: A });
  assert.deepEqual(eu.resources.map((r) => [r.name, r.hidden, r.region]), [["primary", true, "eu-west-1"]]);
  assert.deepEqual(simAthena("ap-south-1"), []);
});

// The provider's I/O: ListWorkGroups (50 per page), the list handed to ctx.checkpoint, then GetWorkGroup per workgroup
// (enrich). providers/athena.ts imports "server-only": child process, react-server condition, the SDK's send() faked.
test("athena provider: ListWorkGroups 50 per page, checkpoint, then GetWorkGroup per workgroup", () => {
  const provider = new URL("../server/providers/athena.ts", import.meta.url).href;
  const script = `
    const { AthenaClient } = await import("@aws-sdk/client-athena");
    const calls = [];
    AthenaClient.prototype.send = async function (cmd) {
      const op = cmd.constructor.name.replace(/Command$/, ""), i = cmd.input;
      calls.push([op, i.MaxResults ?? i.WorkGroup ?? null]);
      if (op === "ListWorkGroups") return { WorkGroups: [{ Name: "primary", State: "ENABLED" }, { Name: "analysts", State: "ENABLED" }] };
      if (op === "GetWorkGroup") return { WorkGroup: { Name: i.WorkGroup, State: "ENABLED", Configuration: i.WorkGroup === "analysts" ? { ResultConfiguration: { OutputLocation: "s3://acme-lake/r/" }, AdditionalConfiguration: "${SENTINEL}" } : { ResultConfiguration: {} } } };
      throw new Error("unexpected " + op);
    };
    const { athenaProvider } = await import(${JSON.stringify(provider)});
    const checkpoints = [];
    const ctx = { region: "${R}", accountId: "${A}", mock: false, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: () => {}, checkpoint: (r) => checkpoints.push(r.resources.map((x) => x.name)) };
    const r = await athenaProvider.discover(ctx);
    process.stdout.write(JSON.stringify({ calls, checkpoints, result: r }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  assert.deepEqual(out.calls, [["ListWorkGroups", 50], ["GetWorkGroup", "primary"], ["GetWorkGroup", "analysts"]]);
  assert.deepEqual(out.checkpoints, [["primary", "analysts"]]);
  assert.deepEqual(out.result.resources.map((r: { name: string; hidden?: boolean }) => [r.name, !!r.hidden]), [["primary", true], ["analysts", false]]);
  assert.equal(out.result.links.length, 1);
  assert.ok(!JSON.stringify(out.result).includes(SENTINEL));
});
