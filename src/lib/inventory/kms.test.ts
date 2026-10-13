import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { aliasesByKey, kmsDetail, kmsResult, rotationApplies, type RawKmsKey } from "./kms.ts";
import { simKms } from "../server/providers/mock/kms.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const SENTINEL = "SENTINEL-kms-41d0e2";
const arn = (id: string) => `arn:aws:kms:${R}:${A}:key/${id}`;

// Golden: ListKeys + ListAliases joined, DescribeKey metadata, rotation and tags as the provider reads them. The key
// policy (never read by the provider) carries the sentinel to prove unknown fields are never copied.
const aliases = aliasesByKey([
  { AliasName: "alias/app", TargetKeyId: "k-app" },
  { AliasName: "alias/app-legacy-name", TargetKeyId: "k-app" },
  { AliasName: "alias/aws/rds", TargetKeyId: "k-rds" },
  { AliasName: "alias/aws/ebs" }, // no TargetKeyId: AWS hasn't created the key yet — skipped
]);
const GOLDEN: RawKmsKey[] = [
  {
    KeyId: "k-app", KeyArn: arn("k-app"), aliases: aliases.get("k-app"), enrichment: { describe: "ok", rotation: "ok", tags: "ok" },
    metadata: { KeyManager: "CUSTOMER", KeyState: "Enabled", KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT", Origin: "AWS_KMS", Description: "app data", CreationDate: new Date(NOW - 100 * DAY), Policy: SENTINEL } as never,
    rotation: { KeyRotationEnabled: true, RotationPeriodInDays: 180, NextRotationDate: new Date("2027-01-01T00:00:00Z") },
    tags: [{ TagKey: "Environment", TagValue: "production" }],
  },
  { KeyId: "k-rds", KeyArn: arn("k-rds"), aliases: aliases.get("k-rds"), enrichment: { describe: "ok" }, metadata: { KeyManager: "AWS", KeyState: "Enabled", KeySpec: "SYMMETRIC_DEFAULT" } },
  { KeyId: "k-old", KeyArn: arn("k-old"), aliases: [], enrichment: { describe: "ok", tags: "ok" }, metadata: { KeyManager: "CUSTOMER", KeyState: "PendingDeletion", DeletionDate: new Date("2026-10-10T00:00:00Z"), KeySpec: "SYMMETRIC_DEFAULT" }, tags: [] },
  { KeyId: "k-off", KeyArn: arn("k-off"), aliases: [], enrichment: { describe: "ok", rotation: "denied", tags: "capped" }, metadata: { KeyManager: "CUSTOMER", KeyState: "Disabled", KeySpec: "SYMMETRIC_DEFAULT" } },
  { KeyId: "k-denied", KeyArn: arn("k-denied"), aliases: ["alias/aws/acm"], enrichment: { describe: "denied" } }, // a key policy denied DescribeKey
  { KeyId: "k-hmac", KeyArn: arn("k-hmac"), aliases: [], enrichment: { describe: "ok", tags: "ok" }, metadata: { KeyManager: "CUSTOMER", KeyState: "Enabled", KeySpec: "HMAC_256", KeyUsage: "GENERATE_VERIFY_MAC" }, tags: [] },
];
const result = () => kmsResult(GOLDEN, { region: R, account: A });
const byId = (id: string) => result().resources.find((r) => r.key === arn(id))!;

test("KMS: aliases are the key id, alias names and alias ARNs; aliases without a target key are skipped", () => {
  assert.deepEqual([...aliases.keys()], ["k-app", "k-rds"]);
  const app = byId("k-app");
  assert.equal(app.name, "app");
  assert.deepEqual(app.aliases, ["k-app", "alias/app", "alias/app-legacy-name", `arn:aws:kms:${R}:${A}:alias/app`, `arn:aws:kms:${R}:${A}:alias/app-legacy-name`]);
  assert.deepEqual(app.tags, { Environment: "production" });
  assert.equal(app.props.find((p) => p.label === "Rotation")?.value, "every 180 days (next 2027-01-01)");
  assert.equal(app.health, "ok");
  assert.deepEqual(app.facts, { state: "Enabled" });
  assert.equal(result().links.length, 0, "what a key encrypts comes from its consumers");
});

test("KMS: AWS-managed keys are hidden — by KeyManager, or by an alias/aws/ alias when DescribeKey was denied", () => {
  assert.equal(byId("k-rds").hidden, true);
  assert.equal(byId("k-rds").name, "aws/rds");
  assert.ok(byId("k-rds").aliases?.includes(`arn:aws:kms:${R}:${A}:alias/aws/rds`));
  assert.equal(byId("k-denied").hidden, true);
  assert.equal(byId("k-denied").health, "unknown");
  assert.equal(byId("k-denied").healthReason, "key state not read (denied)");
  assert.equal(byId("k-app").hidden, undefined);
});

test("KMS: health and facts from KeyState; unread tags fail closed", () => {
  const old = byId("k-old");
  assert.equal(old.health, "error");
  assert.equal(old.healthReason, "scheduled for deletion on 2026-10-10");
  assert.deepEqual(old.facts, { state: "PendingDeletion", deletionDate: "2026-10-10T00:00:00.000Z" });
  assert.equal(old.props.find((p) => p.label === "Rotation"), undefined, "no rotation for a key pending deletion");
  const off = byId("k-off");
  assert.equal(off.health, "warning");
  assert.equal(off.tagsUnread, true);
  assert.deepEqual(off.enrichment, { describe: "ok", rotation: "denied", tags: "capped" });
  assert.equal(off.props.find((p) => p.label === "Rotation")?.value, "rotation not read (denied)");
  assert.equal(rotationApplies(GOLDEN[5]), false, "HMAC keys don't rotate");
});

test("KMS: no secret sentinel in resources or detail", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  assert.ok(!JSON.stringify(kmsDetail(arn("k-app"), GOLDEN[0])).includes(SENTINEL));
  assert.match(kmsDetail(arn("k-denied"), GOLDEN[4]).sections[0].note ?? "", /couldn't be read/);
});

test("KMS: the Acme simulation per region — app key + legacy + 3 hidden AWS keys at home, the replica in eu-west-1", () => {
  const home = kmsResult(simKms("us-east-1", NOW), { region: "us-east-1", account: A }).resources;
  assert.equal(home.length, 5);
  assert.equal(home.filter((r) => r.hidden).length, 3);
  assert.deepEqual(home.filter((r) => !r.hidden).map((r) => [r.name, r.health]), [["acme-production", "ok"], ["acme-legacy-backups", "error"]]);
  assert.match(home[0].props.find((p) => p.label === "Multi-Region")?.value ?? "", /primary, replicas in eu-west-1/);
  const eu = kmsResult(simKms("eu-west-1", NOW), { region: "eu-west-1", account: A }).resources;
  assert.equal(eu.length, 1);
  assert.equal(eu[0].region, "eu-west-1");
  assert.match(eu[0].props.find((p) => p.label === "Multi-Region")?.value ?? "", /replica of the primary in us-east-1/);
  assert.deepEqual(simKms("ap-south-1", NOW), []);
});

// The provider's I/O (CC-19): a key policy that denies one key answers for that key only — the other keys are still
// described — and the list calls stay inside the documented page sizes (ListAliases: 100). providers/kms.ts imports
// "server-only", so it runs in a child process under the react-server condition with the SDK's send() faked.
test("KMS provider: a DescribeKey denied by one key's policy marks that key only; page sizes per the SDK model", () => {
  const provider = new URL("../server/providers/kms.ts", import.meta.url).href;
  const script = `
    const { KMSClient } = await import("@aws-sdk/client-kms");
    const calls = [];
    const meta = (id, manager) => ({ KeyId: id, Arn: "arn:aws:kms:ap-south-1:${A}:key/" + id, KeyManager: manager, KeyState: "Enabled", KeySpec: "SYMMETRIC_DEFAULT", Origin: "AWS_KMS" });
    KMSClient.prototype.send = async function (cmd) {
      const op = cmd.constructor.name.replace(/Command$/, ""), i = cmd.input;
      calls.push([op, i.KeyId ?? null, i.Limit ?? null]);
      if (op === "ListKeys") return { Keys: ["k-a", "k-locked", "k-b", "k-aws"].map((id) => ({ KeyId: id, KeyArn: "arn:aws:kms:ap-south-1:${A}:key/" + id })) };
      if (op === "ListAliases") return { Aliases: [{ AliasName: "alias/app", TargetKeyId: "k-a" }, { AliasName: "alias/aws/rds", TargetKeyId: "k-aws" }, { AliasName: "alias/aws/ebs" }] };
      if (op === "DescribeKey") {
        if (i.KeyId === "k-locked") throw Object.assign(new Error("User: arn:aws:sts::${A}:assumed-role/console/x is not authorized to perform: kms:DescribeKey on resource: k-locked because no resource-based policy allows the kms:DescribeKey action"), { name: "AccessDeniedException" });
        return { KeyMetadata: meta(i.KeyId, i.KeyId === "k-aws" ? "AWS" : "CUSTOMER") };
      }
      if (op === "GetKeyRotationStatus") return { KeyRotationEnabled: true, RotationPeriodInDays: 365 };
      if (op === "ListResourceTags") {
        if (i.KeyId === "k-b") throw Object.assign(new Error("User: u is not authorized to perform: kms:ListResourceTags on resource: k-b"), { name: "AccessDeniedException" });
        return { Tags: [{ TagKey: "Team", TagValue: "platform" }] };
      }
      throw new Error("unexpected " + op);
    };
    const { kmsProvider } = await import(${JSON.stringify(provider)});
    const notes = [], checkpoints = [];
    const ctx = { region: "ap-south-1", home: "ap-south-1", accountId: "${A}", mock: false, cap: 2000, signal: new AbortController().signal,
      limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r.resources.length) };
    const r = await kmsProvider.discover(ctx);
    process.stdout.write(JSON.stringify({ calls, notes, checkpoints, resources: r.resources.map((x) => ({ id: x.key.split("/").pop(), hidden: !!x.hidden, health: x.health, enrichment: x.enrichment, tags: x.tags, tagsUnread: !!x.tagsUnread })) }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  const by = (id: string) => out.resources.find((x: { id: string }) => x.id === id);
  assert.deepEqual(out.calls.filter((c: unknown[]) => c[0] === "DescribeKey").map((c: unknown[]) => c[1]).sort(), ["k-a", "k-aws", "k-b", "k-locked"], "the keys after the denied one are still described");
  assert.deepEqual(out.calls.find((c: unknown[]) => c[0] === "ListAliases"), ["ListAliases", null, 100]);
  assert.deepEqual(out.calls.find((c: unknown[]) => c[0] === "ListKeys"), ["ListKeys", null, 1000]);
  assert.deepEqual(out.checkpoints, [4], "the listed keys are handed over before enrichment");
  assert.deepEqual([by("k-locked").health, by("k-locked").enrichment], ["unknown", { describe: "denied" }]);
  assert.deepEqual(by("k-a").enrichment, { describe: "ok", rotation: "ok", tags: "ok" });
  assert.deepEqual(by("k-a").tags, { Team: "platform" });
  assert.deepEqual([by("k-b").enrichment.tags, by("k-b").tagsUnread], ["denied", true], "a tag read denied for one key leaves that key tagsUnread");
  assert.equal(by("k-aws").hidden, true);
  assert.deepEqual(out.calls.filter((c: unknown[]) => c[0] === "ListResourceTags").map((c: unknown[]) => c[1]).sort(), ["k-a", "k-b"], "no tag reads for AWS-managed or unreadable keys");
  assert.ok(out.notes.some((n: string) => /kms key details: 1 key refused kms:DescribeKey/.test(n)), out.notes.join(" | "));
});
