// Simulated ECR of the Acme account (names from ../mock-names.ts), answering the calls the ecr provider makes, per region
// (the provider sets multiRegionMock). What ECS runs isn't simulated here: the provider reads it from the simulated ECS
// discovery like the real one, and asks for those tags and digests. An image's digest is the SHA-256 of its full image
// reference — the same rule ../../mock.ts uses for the digests its tasks report, so facts.tagDigests and the running
// tasks agree (F68).
// us-east-1: the four repositories ECS pulls from (storefront-api, jobs, billing, deployment-console) and
// acme/legacy-admin, which nobody has pushed to or pulled from in months (idle). The image worker runs (acme/jobs) has
// a critical finding (a warning on the repository). billing's repository is encrypted with the application key.
// eu-west-1: the replicas of storefront-api and jobs that the EU estate pulls from. Other regions: none. Read-only.
import { createHash } from "node:crypto";
import { arnOf } from "../../../inventory/arn.ts";
import type { Lifecycle, RawFinding, RawImage, RawRepository } from "../../../inventory/ecr.ts";
import { ACCT, ECR_REPOS, EU_REGION, KMS_KEYS, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const HOUR = 3_600_000;
const registry = (region: string) => `${ACCT}.dkr.ecr.${region}.amazonaws.com`;
export const simDigest = (region: string, repository: string, tag: string) => `sha256:${createHash("sha256").update(`${registry(region)}/${repository}:${tag}`).digest("hex")}`;

interface SimRepo { name: string; ageDays: number; kms?: string; lifecycle?: Lifecycle; tags: Record<string, string>; idle?: boolean; critical?: number }
const EXPIRE: Lifecycle = { rules: 1, descriptions: ["expire untagged images after 14 days"] };
const HOME: SimRepo[] = [
  { name: ECR_REPOS.storefrontApi.name, ageDays: 900, lifecycle: EXPIRE, tags: { team: "storefront" } },
  { name: ECR_REPOS.jobs.name, ageDays: 900, lifecycle: EXPIRE, tags: { team: "platform" }, critical: 1 },
  { name: ECR_REPOS.billing.name, ageDays: 400, kms: KMS_KEYS.app.arn, lifecycle: EXPIRE, tags: { team: "payments" } },
  { name: ECR_REPOS.deploymentConsole.name, ageDays: 120, tags: { team: "platform" } },
  { name: ECR_REPOS.legacyAdmin.name, ageDays: 1500, tags: { team: "admin", Environment: "production" }, idle: true },
];
// The EU estate pulls from replicas (ECR replication from us-east-1).
const EU: SimRepo[] = [
  { name: ECR_REPOS.storefrontApi.name, ageDays: 200, lifecycle: EXPIRE, tags: { team: "storefront", replica: "us-east-1" } },
  { name: ECR_REPOS.jobs.name, ageDays: 200, lifecycle: EXPIRE, tags: { team: "platform", replica: "us-east-1" }, critical: 1 },
];
const reposIn = (region: string) => (region === REGION ? HOME : region === EU_REGION ? EU : []);
const repo = (region: string, name: string) => reposIn(region).find((r) => r.name === name);

export function simRepositories(region: string, now: number = Date.now()): RawRepository[] {
  return reposIn(region).map((r) => ({
    repositoryArn: arnOf.ecrRepository(region, ACCT, r.name), registryId: ACCT, repositoryName: r.name, repositoryUri: `${registry(region)}/${r.name}`,
    createdAt: new Date(now - r.ageDays * DAY), imageTagMutability: "MUTABLE", imageScanningConfiguration: { scanOnPush: true },
    encryptionConfiguration: r.kms ? { encryptionType: "KMS", kmsKey: r.kms } : { encryptionType: "AES256" },
  }));
}

// A tag ECS runs: pushed a few days ago, pulled within the hour. An unknown digest isn't in the repository.
function image(region: string, r: SimRepo, tag: string, now: number): RawImage {
  const crit = r.critical ?? 0;
  return {
    imageDigest: simDigest(region, r.name, tag), imageTags: [tag], imageSizeInBytes: 180_000_000 + (tag.length % 7) * 3_000_000,
    imagePushedAt: new Date(now - 3 * DAY), lastRecordedPullTime: new Date(now - HOUR), imageStatus: "ACTIVE",
    imageScanStatus: { status: "COMPLETE" },
    imageScanFindingsSummary: { findingSeverityCounts: { ...(crit ? { CRITICAL: crit } : {}), HIGH: 2, MEDIUM: 7 }, imageScanCompletedAt: new Date(now - 3 * DAY + 60_000) },
  };
}

// DescribeImages by imageIds: tags always exist (the simulation pushed them), except the ones whose name starts with
// "deleted-"; a digest exists when it is one of the asked-for tags' digests (how the provider asks: tags and digests of
// one repository together). Like ECR, one id that isn't there fails the whole call with ImageNotFoundException.
export function simImagesById(region: string, repository: string, ids: { imageTag?: string; imageDigest?: string }[], now: number = Date.now()): RawImage[] {
  const r = repo(region, repository);
  if (!r) throw Object.assign(new Error(`The repository with name '${repository}' does not exist`), { name: "RepositoryNotFoundException" });
  const byTag = new Map(ids.filter((x) => x.imageTag && !x.imageTag.startsWith("deleted-")).map((x) => [x.imageTag!, image(region, r, x.imageTag!, now)]));
  const out = new Map([...byTag.values()].map((i) => [i.imageDigest!, i]));
  for (const x of ids) {
    const found = x.imageTag ? byTag.has(x.imageTag) : [...byTag.values()].some((i) => i.imageDigest === x.imageDigest);
    if (!found) throw Object.assign(new Error(`The image with imageId {imageDigest:'${x.imageDigest ?? "null"}', imageTag:'${x.imageTag ?? "null"}'} does not exist within the repository with name '${repository}'`), { name: "ImageNotFoundException" });
  }
  return [...out.values()];
}

// The first page of a repository (unsorted, like the API): older builds, plus for the idle one nothing recent.
export function simFirstPage(region: string, repository: string, now: number = Date.now()): { images: RawImage[]; more: boolean } {
  const r = repo(region, repository);
  if (!r) return { images: [], more: false };
  const ages = r.idle ? [420, 300, 260] : [40, 25, 12, 6];
  return {
    images: ages.map((age, i) => ({
      imageDigest: simDigest(region, r.name, `build-${age}`), imageTags: i === ages.length - 1 && !r.idle ? [] : [`build-${age}`], imageSizeInBytes: 170_000_000 + i * 4_000_000,
      imagePushedAt: new Date(now - age * DAY), ...(r.idle ? { lastRecordedPullTime: new Date(now - (age - 150) * DAY) } : { lastRecordedPullTime: new Date(now - Math.min(age, 10) * DAY) }),
      imageStatus: "ACTIVE", imageScanStatus: { status: "COMPLETE" }, imageScanFindingsSummary: { findingSeverityCounts: { MEDIUM: 3 } },
    })),
    more: false,
  };
}

export const simLifecycle = (region: string, repository: string): Lifecycle | null => repo(region, repository)?.lifecycle ?? null;
export const simTags = (region: string, repository: string) => Object.entries(repo(region, repository)?.tags ?? {}).map(([Key, Value]) => ({ Key, Value }));

// DescribeImageScanFindings (panel only): the critical one in acme/jobs, and a couple of high ones everywhere.
export function simFindings(region: string, repository: string): RawFinding[] {
  const r = repo(region, repository);
  if (!r) return [];
  return [
    ...(r.critical ? [{ name: "CVE-2026-31337", severity: "CRITICAL", uri: "https://nvd.nist.gov/vuln/detail/CVE-2026-31337", attributes: [{ key: "package_name", value: "openssl" }, { key: "package_version", value: "3.0.13-1" }] }] : []),
    { name: "CVE-2026-20145", severity: "HIGH", attributes: [{ key: "package_name", value: "libxml2" }, { key: "package_version", value: "2.9.14" }] },
    { name: "CVE-2026-11873", severity: "HIGH", attributes: [{ key: "package_name", value: "zlib" }, { key: "package_version", value: "1.2.13" }] },
  ];
}
