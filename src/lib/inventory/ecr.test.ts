import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeFound, ecrDetail, ecrImageOf, ecrResults, imageIdBatches, lifecycleOf, pullLinks, usesByRepo, type EcrRaw, type EcsImageUse, type RawImage } from "./ecr.ts";
import { simDigest, simFirstPage, simImagesById, simRepositories } from "../server/providers/mock/ecr.ts";
import type { Resource } from "./types.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const SENTINEL = "SENTINEL-ecr-7c19ab";
const REG = `${A}.dkr.ecr.${R}.amazonaws.com`;
const repoArn = (name: string, region = R) => `arn:aws:ecr:${region}:${A}:repository/${name}`;
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const D3 = `sha256:${"c".repeat(64)}`;

// What ECS runs: api by a mutable tag (its tasks report D1), worker by digest, an EU service from its own registry, a
// Docker Hub sidecar, a hidden service, and a tag that was deleted from the repository.
const USES: EcsImageUse[] = [
  { service: "ecs:service/prod/api", label: "production/api", container: "api", image: `${REG}/shop/api:production`, digest: D1 },
  { service: "ecs:service/prod/api", label: "production/api", container: "proxy", image: "caddy:2-alpine" },
  { service: "ecs:service/prod/worker", label: "production/worker", container: "worker", image: `${REG}/shop/worker@${D2}`, digest: D2 },
  { service: "ecs:service/prod/old", label: "production/old", container: "old", image: `${REG}/shop/api:gone-tag` },
  { service: "ecs:service/prod/console", label: "production/console", container: "console", image: `${REG}/shop/console:v1`, hidden: true },
  { service: "ecs:service/prod/api@eu-west-1", label: "production-eu-west-1/api", container: "api", image: `${A}.dkr.ecr.eu-west-1.amazonaws.com/shop/api:production` },
];

const img = (digest: string, tags: string[], pushedDaysAgo: number, pulledDaysAgo?: number, critical = 0): RawImage => ({
  imageDigest: digest, imageTags: tags, imageSizeInBytes: 100_000_000, imagePushedAt: new Date(NOW - pushedDaysAgo * DAY),
  ...(pulledDaysAgo !== undefined ? { lastRecordedPullTime: new Date(NOW - pulledDaysAgo * DAY) } : {}),
  imageScanFindingsSummary: { findingSeverityCounts: { ...(critical ? { CRITICAL: critical } : {}), HIGH: 1 } },
});

// Golden: the API's shapes. A repository policy (never read) and an image's config carry the sentinel to prove unknown
// fields are never copied.
const GOLDEN: EcrRaw = {
  repos: [
    { repositoryArn: repoArn("shop/api"), registryId: A, repositoryName: "shop/api", repositoryUri: `${REG}/shop/api`, createdAt: new Date(NOW - 400 * DAY), imageTagMutability: "MUTABLE", imageScanningConfiguration: { scanOnPush: true }, encryptionConfiguration: { encryptionType: "AES256" }, policyText: SENTINEL } as never,
    { repositoryArn: repoArn("shop/worker"), registryId: A, repositoryName: "shop/worker", repositoryUri: `${REG}/shop/worker`, createdAt: new Date(NOW - 400 * DAY), encryptionConfiguration: { encryptionType: "KMS", kmsKey: `arn:aws:kms:${R}:${A}:key/k-1` } },
    { repositoryArn: repoArn("shop/legacy"), registryId: A, repositoryName: "shop/legacy", createdAt: new Date(NOW - 900 * DAY), encryptionConfiguration: { encryptionType: "AES256" } },
    { repositoryArn: repoArn("shop/empty"), registryId: A, repositoryName: "shop/empty", createdAt: new Date(NOW - 90 * DAY) },
    { repositoryArn: repoArn("shop/console"), registryId: A, repositoryName: "shop/console", createdAt: new Date(NOW - 30 * DAY) },
  ],
  inUse: {
    [repoArn("shop/api")]: { state: "ok", value: [{ ...img(D1, ["production", "v42"], 2, 0.1), config: SENTINEL } as RawImage] },
    [repoArn("shop/worker")]: { state: "ok", value: [img(D2, ["v7"], 10, 0.5, 2)] },
    [repoArn("shop/console")]: { state: "denied" },
  },
  firstPage: {
    [repoArn("shop/api")]: { state: "ok", value: { images: [img(D3, ["v41"], 9, 3)], more: true } },
    [repoArn("shop/worker")]: { state: "ok", value: { images: [], more: false } },
    [repoArn("shop/legacy")]: { state: "ok", value: { images: [img(`sha256:${"d".repeat(64)}`, ["old"], 300, 200)], more: false } },
    [repoArn("shop/empty")]: { state: "ok", value: { images: [], more: false } },
    [repoArn("shop/console")]: { state: "skipped" },
  },
  lifecycle: {
    [repoArn("shop/api")]: { state: "ok", value: { rules: 1, descriptions: ["expire untagged"] } },
    [repoArn("shop/legacy")]: { state: "ok", value: null },
    [repoArn("shop/worker")]: { state: "denied" },
  },
  tags: {
    [repoArn("shop/api")]: { state: "ok", value: [{ Key: "Environment", Value: "production" }] },
    [repoArn("shop/worker")]: { state: "ok", value: [] },
    [repoArn("shop/legacy")]: { state: "capped" },
  },
};
const result = (linkPulls = true) => ecrResults(GOLDEN, { region: R, accountId: A, now: NOW, uses: USES, linkPulls });
const byName = (n: string) => result().resources.find((r) => r.name === n)!;
const prop = (r: Resource, label: string) => r.props.find((p) => p.label === label)?.value;

test("ECR: image references parse with parseImageRef — ECR only, any region, tag or digest", () => {
  assert.deepEqual(ecrImageOf(`${REG}/shop/api:production`), { arn: repoArn("shop/api"), region: R, account: A, repository: "shop/api", tag: "production", digest: undefined });
  assert.equal(ecrImageOf(`${REG}/shop/worker@${D2}`)?.digest, D2);
  assert.equal(ecrImageOf("caddy:2-alpine"), undefined);
  assert.equal(ecrImageOf("public.ecr.aws/nginx/nginx:1"), undefined);
  assert.equal(ecrImageOf(`${A}.dkr.ecr.eu-west-1.amazonaws.com/shop/api`)?.arn, repoArn("shop/api", "eu-west-1"));
});

test("ECR: what ECS runs, per repository of this region — tags, named digests and the digests tasks report", () => {
  const u = usesByRepo(USES, R, A);
  assert.deepEqual([...u.keys()].sort(), [repoArn("shop/api"), repoArn("shop/console"), repoArn("shop/worker")]);
  assert.deepEqual(u.get(repoArn("shop/api"))!.tags, ["gone-tag", "production"]);
  assert.deepEqual(u.get(repoArn("shop/api"))!.digests, [D1]);
  assert.deepEqual(u.get(repoArn("shop/worker"))!.digests, [D2]);
  assert.equal(usesByRepo(USES, R, "210987654321").size, 0, "another account's registry is not ours to describe");
  // ≤100 imageIds per DescribeImages call
  const many = { repository: "x", tags: Array.from({ length: 150 }, (_, i) => `t${i}`), digests: Array.from({ length: 70 }, (_, i) => `sha256:${i}`), users: [] };
  assert.deepEqual(imageIdBatches(many).map((b) => b.length), [100, 100, 20]);
  assert.deepEqual(imageIdBatches(many)[0][0], { imageTag: "t0" });
});

test("ECR: ECS → repository pulls links (one per pair, every region, not for hidden services), only from the home run", () => {
  const links = pullLinks(USES);
  assert.deepEqual(links.map((l) => [l.from, l.to, l.label]), [
    ["ecs:service/prod/api", repoArn("shop/api"), "production"],
    ["ecs:service/prod/worker", repoArn("shop/worker"), `@${D2.slice(0, 19)}`],
    ["ecs:service/prod/old", repoArn("shop/api"), "gone-tag"],
    ["ecs:service/prod/api@eu-west-1", repoArn("shop/api", "eu-west-1"), "production"],
  ]);
  assert.ok(links.every((l) => l.kind === "pulls" && l.evidence.includes("container")));
  assert.equal(result(false).links.filter((l) => l.kind === "pulls").length, 0, "other regions' runs don't draw them");
  assert.equal(result(true).links.filter((l) => l.kind === "pulls").length, 4);
});

test("ECR: F68 — tagDigests say what each tag ECS references points to now", () => {
  const api = byName("shop/api");
  assert.deepEqual(api.facts, { tagDigests: [`production|${D1}`] });
  assert.equal(prop(api, "Used by"), "production/api (production), production/old (gone-tag)");
  assert.equal(byName("shop/worker").facts, undefined, "worker runs by digest: no tag to resolve");
});

test("ECR: health — a tag ECS runs that is gone, or a critical finding in an image ECS runs, is a warning", () => {
  const api = byName("shop/api");
  assert.equal(api.health, "warning");
  assert.equal(api.healthReason, "image gone-tag ECS runs is no longer in the repository (production/old) — new tasks can't start");
  const worker = byName("shop/worker");
  assert.equal(worker.health, "warning");
  assert.equal(worker.healthReason, "2 critical vulnerabilities in an image ECS runs");
  assert.equal(byName("shop/legacy").health, "ok");
  assert.equal(byName("shop/console").health, "ok", "an unread check is not a warning");
  assert.equal(byName("shop/console").enrichment?.inUse, "denied");
});

test("ECR: idle evidence — newest push or pull; an empty repository counts from its creation; unread → none", () => {
  assert.equal(byName("shop/api").lastActivityAt, NOW - 0.1 * DAY);
  assert.equal(byName("shop/legacy").lastActivityAt, NOW - 200 * DAY);
  assert.equal(byName("shop/empty").lastActivityAt, NOW - 90 * DAY);
  assert.equal(byName("shop/console").lastActivityAt, undefined);
  assert.equal(prop(byName("shop/api"), "Images"), "1+");
});

test("ECR: tags, lifecycle, encryption, keys and links", () => {
  const api = byName("shop/api");
  assert.equal(api.key, repoArn("shop/api"));
  assert.deepEqual(api.tags, { Environment: "production" });
  assert.equal(api.tagsUnread, undefined);
  assert.deepEqual(api.aliases, ["shop/api", `${REG}/shop/api`]);
  assert.equal(prop(api, "Lifecycle policy"), "1 rule: expire untagged");
  assert.equal(prop(byName("shop/legacy"), "Lifecycle policy"), "none — images are kept forever");
  assert.equal(prop(byName("shop/worker"), "Lifecycle policy"), "lifecycle policy not read (denied)");
  assert.equal(byName("shop/legacy").tagsUnread, true);
  assert.equal(byName("shop/empty").tagsUnread, true, "never attempted → unread");
  assert.deepEqual(result().links.find((l) => l.kind === "encrypts"), { from: `arn:aws:kms:${R}:${A}:key/k-1`, to: repoArn("shop/worker"), kind: "encrypts", label: "images", evidence: "ECR repository encryption key (encryptionConfiguration.kmsKey)" });
  assert.deepEqual(lifecycleOf('{"rules":[{"rulePriority":1,"description":"keep 30"},{"rulePriority":2}]}'), { rules: 2, descriptions: ["keep 30"] });
  assert.equal(lifecycleOf(undefined), null);
});

test("ECR: no secret sentinel in resources or detail; detail sorts images newest first", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  const d = ecrDetail(repoArn("shop/api"), [img(D3, ["v41"], 9), { ...img(D1, ["production"], 2), config: SENTINEL } as RawImage], [{ image: D1.slice(0, 19), findings: [{ name: "CVE-1", severity: "CRITICAL", attributes: [{ key: "package_name", value: "openssl" }] }, { name: "CVE-2", severity: "LOW" }] }], { tagDigests: [`production|${D1}`] });
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.deepEqual(d.sections.map((s) => s.title), ["Tags ECS runs", "Images (newest 2)", "Critical and high findings in images ECS runs"]);
  assert.equal(d.sections[1].table?.rows[0][0], "production");
  assert.deepEqual(d.sections[2].table?.rows, [[D1.slice(0, 19), "CRITICAL", "CVE-1", "openssl", ""]]);
  assert.equal(ecrDetail("k", undefined).sections[0].note, "The images couldn't be read.");
  assert.equal(d.sections[1].note, undefined);
  assert.match(ecrDetail("k", [img(D3, ["v41"], 9)], [], undefined, true).sections[0].note ?? "", /newest of the first 1 it returned/);
});

// Verified live: DescribeImages with one missing imageTag among existing ids answers ImageNotFoundException for the whole
// call. Without the split, a deleted tag hid every image of the repository and the "no longer in the repository"
// warning could never fire.
test("ECR: a batch with a missing id is split until the missing one stands alone — the others still resolve", async () => {
  const have = new Map([["production", D1], ["v42", D1], ["v7", D2]]);
  const calls: number[] = [];
  const call = async (ids: { imageTag?: string }[]) => {
    calls.push(ids.length);
    const gone = ids.find((x) => !have.has(x.imageTag!));
    if (gone) throw Object.assign(new Error(`The image with imageId {imageTag:'${gone.imageTag}'} does not exist`), { name: "ImageNotFoundException" });
    return ids.map((x) => img(have.get(x.imageTag!)!, [x.imageTag!], 1));
  };
  const ids = ["production", "gone-1", "v42", "v7", "gone-2"].map((imageTag) => ({ imageTag }));
  const found = await describeFound(ids, call);
  assert.deepEqual(found.map((i) => i.imageTags![0]), ["production", "v42", "v7"]);
  assert.ok(calls.length <= 9, `bounded: ${calls.join(",")}`);
  assert.deepEqual(await describeFound([], call), []);
  // Anything else (denied, throttled, no such repository) is the caller's to handle.
  await assert.rejects(describeFound([{ imageTag: "x" }], async () => { throw Object.assign(new Error("no"), { name: "AccessDeniedException" }); }), { name: "AccessDeniedException" });
  // Through the mapper: the found tag resolves and the gone one is the warning.
  const out = ecrResults({ repos: [GOLDEN.repos[0]], inUse: { [repoArn("shop/api")]: { state: "ok", value: await describeFound([{ imageTag: "production" }, { imageTag: "gone-tag" }], async (x) => (x.some((i) => i.imageTag === "gone-tag") ? Promise.reject(Object.assign(new Error(), { name: "ImageNotFoundException" })) : [img(D1, ["production"], 1)])) } } }, { region: R, accountId: A, now: NOW, uses: USES.filter((u) => u.service !== "ecs:service/prod/api@eu-west-1") });
  assert.deepEqual(out.resources[0].facts, { tagDigests: [`production|${D1}`] });
  assert.match(out.resources[0].healthReason ?? "", /image gone-tag ECS runs is no longer in the repository/);
});

test("ECR: scan findings in the panel — unread or never scanned is said so, never shown as \"no findings\"", () => {
  const section = (f: { image: string; findings?: { severity?: string; name?: string }[] | null }[]) => ecrDetail("k", [], f).sections.at(-1)!;
  assert.equal(section([{ image: "a" }]).note, "The scan findings couldn't be read.");
  assert.equal(section([{ image: "a", findings: null }]).note, "These images were never scanned.");
  assert.equal(section([{ image: "a", findings: [{ severity: "LOW" }] }, { image: "b" }]).note, "No critical or high findings; findings of 1 image couldn't be read.");
  assert.equal(section([{ image: "a", findings: [] }]).note, "No critical or high findings.");
  const mixed = section([{ image: "a", findings: [{ name: "CVE-H", severity: "HIGH" }, { name: "CVE-C", severity: "CRITICAL" }] }, { image: "b", findings: null }]);
  assert.deepEqual(mixed.table?.rows.map((r) => r[2]), ["CVE-C", "CVE-H"], "critical first");
  assert.equal(mixed.note, "Also: 1 image never scanned.");
});

test("ECR: the Acme simulation per region — five repositories at home, two replicas in eu-west-1, none elsewhere", async () => {
  assert.deepEqual(simRepositories("us-east-1", NOW).map((r) => r.repositoryName), ["acme/storefront-api", "acme/jobs", "acme/billing", "acme/deployment-console", "acme/legacy-admin"]);
  assert.deepEqual(simRepositories("eu-west-1", NOW).map((r) => r.repositoryArn), [repoArn("acme/storefront-api", "eu-west-1"), repoArn("acme/jobs", "eu-west-1")]);
  assert.deepEqual(simRepositories("ap-south-1"), []);
  // Digests follow the mock ECS rule: sha256 of the full image reference.
  const ids = [{ imageTag: "production-abc1234" }, { imageDigest: simDigest("us-east-1", "acme/jobs", "production-abc1234") }, { imageDigest: D1 }];
  // Like ECR, one id that isn't there fails the whole call; describeFound recovers the rest.
  assert.throws(() => simImagesById("us-east-1", "acme/jobs", ids, NOW), { name: "ImageNotFoundException" });
  const found = await describeFound(ids, async (x) => simImagesById("us-east-1", "acme/jobs", x, NOW));
  assert.deepEqual(found.map((i) => i.imageDigest), [simDigest("us-east-1", "acme/jobs", "production-abc1234")]);
  const legacy = ecrResults({ repos: simRepositories("us-east-1", NOW), firstPage: { [repoArn("acme/legacy-admin")]: { state: "ok", value: simFirstPage("us-east-1", "acme/legacy-admin", NOW) } } }, { region: R, accountId: A, now: NOW }).resources.find((r) => r.name === "acme/legacy-admin")!;
  assert.ok(legacy.lastActivityAt! < NOW - 100 * DAY, "legacy-admin: nothing pushed or pulled in months (idle)");
});

// The provider against the simulated account (server modules need the react-server condition: a child process): what
// it says a tag points to is what the simulated tasks run, and the home run links every ECS service to its repository.
test("ECR provider (simulated): tagDigests match the digests ECS tasks report; pulls links from the home run", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "dc-ecr-"));
  try {
    const base = new URL("../server/", import.meta.url).href;
    const code = `
      const mod = (p) => import(new URL(p, ${JSON.stringify(base)}).href);
      const { ecrProvider } = await mod("providers/ecr.ts");
      const { listEnvs, servicesOf } = await mod("discovery.ts");
      const ctx = (region) => ({ region, home: "us-east-1", accountId: "123456789012", mock: true, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: () => {}, checkpoint: () => {} });
      const home = await ecrProvider.discover(ctx("us-east-1"));
      const eu = await ecrProvider.discover(ctx("eu-west-1"));
      const prod = (await listEnvs()).find((e) => e.id === "production");
      const api = (await servicesOf(prod.cluster, prod.region)).find((s) => s.name === "api");
      const detail = await ecrProvider.detail(home.resources.find((r) => r.name === "acme/jobs"), ctx("us-east-1"));
      const out = { home, eu, apiImage: api.taskDef.image, apiDigests: api.tasks.filter((x) => x.lastStatus === "RUNNING").map((x) => x.imageDigests?.api), detail };
      process.stdout.write(JSON.stringify(out), () => process.exit(0));`;
    const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_DATA_DIR: dir, CONSOLE_CONFIG: "", AUTH_MODE: "dev", NODE_ENV: "test" },
    });
    assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
    const out = JSON.parse(r.stdout);
    const repo = out.home.resources.find((x: Resource) => x.name === "acme/storefront-api");
    const tag = String(out.apiImage).split(":").pop();
    assert.ok(repo.facts.tagDigests.includes(`${tag}|${out.apiDigests[0]}`), JSON.stringify(repo.facts));
    assert.equal(repo.facts.tagDigests.length, 2, "production and staging tags");
    assert.equal(repo.health, "ok");
    assert.equal(out.home.resources.find((x: Resource) => x.name === "acme/jobs").health, "warning", "the image worker runs has a critical finding");
    const pulls = out.home.links.filter((l: { kind: string }) => l.kind === "pulls");
    assert.ok(pulls.some((l: { from: string; to: string }) => l.from === "ecs:service/acme-production/api" && l.to === repoArn("acme/storefront-api")));
    assert.ok(pulls.some((l: { from: string; to: string }) => l.from === "ecs:service/acme-production/api@eu-west-1" && l.to === repoArn("acme/storefront-api", "eu-west-1")));
    assert.equal(out.eu.links.filter((l: { kind: string }) => l.kind === "pulls").length, 0);
    assert.deepEqual(out.eu.resources.map((x: Resource) => x.name), ["acme/storefront-api", "acme/jobs"]);
    assert.ok(out.eu.resources.every((x: Resource) => x.facts?.tagDigests), "the EU estate's tags resolve in its own region");
    assert.ok(out.detail.sections.some((s: { title: string }) => s.title === "Critical and high findings in images ECS runs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
