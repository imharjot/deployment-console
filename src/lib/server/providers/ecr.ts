// ECR repositories provider (audit §6 A.2 #11, F68): every repository in the region (DescribeRepositories), handed to
// ctx.checkpoint, then per repository within the time budget (R18): the images ECS runs from it, asked for by tag and
// digest (DescribeImages by imageIds, at most 100 per call — the API doesn't sort, so "the newest page" can't be
// trusted), the first page of images of the first 200 repositories (push and pull times, for idle), the lifecycle policy
// (LifecyclePolicyNotFoundException = none) and tags (first 200; unread → tagsUnread, R01). What ECS runs comes from the
// ECS discovery (task definitions + the digests running tasks report) and is optional: when it is slow or fails the
// repositories are still listed, with a note. ECS service → repository `pulls` links are drawn by the home run, for every
// region, once. Scan findings are read only when a panel opens (DescribeImageScanFindings). Read-only: no actions. The
// mapping is pure (../../inventory/ecr.ts); the simulation answers the same calls (./mock/ecr.ts).
import "server-only";
import {
  DescribeImageScanFindingsCommand, DescribeImagesCommand, DescribeRepositoriesCommand, ECRClient, GetLifecyclePolicyCommand, ListTagsForResourceCommand,
  type ImageDetail, type ImageIdentifier,
} from "@aws-sdk/client-ecr";
import { parseArn } from "../../inventory/arn.ts";
import {
  describeFound, ecrDetail, ecrResults, imageIdBatches, lifecycleOf, usesByRepo, type EcrRaw, type EcsImageUse, type Lifecycle, type RawFinding, type RawImage, type RawRepository, type Read,
} from "../../inventory/ecr.ts";
import { keys, type EnrichState } from "../../inventory/types.ts";
import type { RawService } from "../../types.ts";
import { inventory, servicesOf } from "../discovery.ts";
import { errText } from "../errors.ts";
import { homeRegion } from "../sources.ts";
import { simFindings, simFirstPage, simImagesById, simLifecycle, simRepositories, simTags } from "./mock/ecr.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const ecr = perRegion((r) => new ECRClient(sdkConfig(r)), "ecr");
const PAGE = 1_000; // DescribeRepositories and DescribeImages take up to 1,000
const FIRST_PAGES = 200; // repositories whose first image page is read (idle evidence)
const TAG_READS = 200;
const DETAIL_IMAGES = 100;
const FINDINGS_IMAGES = 5; // in-use images whose findings the panel reads
const FINDINGS_PAGES = 3; // DescribeImageScanFindings pages (1,000 findings each) per image

// The calls the provider makes, real or simulated, so both run the same discovery.
interface EcrApi {
  repositories(ctx: ProviderContext): Promise<RawRepository[]>;
  imagesById(repository: string, ids: ImageIdentifier[]): Promise<RawImage[]>;
  firstPage(repository: string, max: number): Promise<{ images: RawImage[]; more: boolean }>;
  lifecycle(repository: string): Promise<Lifecycle | null>;
  tags(arn: string): Promise<{ Key?: string; Value?: string }[]>;
  findings(repository: string, digest: string): Promise<RawFinding[] | null>; // null = the image was never scanned
}

const asImage = (d: ImageDetail): RawImage => ({
  imageDigest: d.imageDigest, imageTags: d.imageTags, imageSizeInBytes: d.imageSizeInBytes, imagePushedAt: d.imagePushedAt, lastRecordedPullTime: d.lastRecordedPullTime,
  imageStatus: d.imageStatus, imageScanStatus: d.imageScanStatus ? { status: d.imageScanStatus.status, description: d.imageScanStatus.description } : undefined,
  imageScanFindingsSummary: d.imageScanFindingsSummary
    ? { findingSeverityCounts: d.imageScanFindingsSummary.findingSeverityCounts as Record<string, number> | undefined, imageScanCompletedAt: d.imageScanFindingsSummary.imageScanCompletedAt }
    : undefined,
});

function realApi(region: string, ctx: { signal?: AbortSignal }): EcrApi {
  const c = ecr(region);
  return {
    repositories: (pctx) =>
      paged(pctx, "ecr repositories", async (nextToken) => {
        const r = await c.send(new DescribeRepositoriesCommand({ maxResults: PAGE, nextToken }), t(pctx));
        return { items: r.repositories, next: r.nextToken };
      }, { service: "ecr" }),
    async imagesById(repositoryName, imageIds) {
      // One id ECR doesn't have fails the whole call (ImageNotFoundException): describeFound splits and asks again.
      const r = await c.send(new DescribeImagesCommand({ repositoryName, imageIds }), t(ctx));
      return (r.imageDetails ?? []).map(asImage);
    },
    async firstPage(repositoryName, maxResults) {
      const r = await c.send(new DescribeImagesCommand({ repositoryName, maxResults }), t(ctx));
      return { images: (r.imageDetails ?? []).map(asImage), more: !!r.nextToken };
    },
    async lifecycle(repositoryName) {
      try {
        return lifecycleOf((await c.send(new GetLifecyclePolicyCommand({ repositoryName }), t(ctx))).lifecyclePolicyText);
      } catch (e) {
        if ((e as { name?: string }).name === "LifecyclePolicyNotFoundException") return null;
        throw e;
      }
    },
    tags: async (resourceArn) => (await c.send(new ListTagsForResourceCommand({ resourceArn }), t(ctx))).tags ?? [],
    // Basic scanning answers `findings`, enhanced scanning (Inspector) `enhancedFindings`; neither is sorted by
    // severity, so a few pages are read. Never scanned → null (ScanNotFoundException), not "no findings".
    async findings(repositoryName, imageDigest) {
      const out: RawFinding[] = [];
      let nextToken: string | undefined;
      try {
        for (let i = 0; i < FINDINGS_PAGES; i++) {
          const r = await c.send(new DescribeImageScanFindingsCommand({ repositoryName, imageId: { imageDigest }, maxResults: 1000, nextToken }), t(ctx));
          for (const f of r.imageScanFindings?.findings ?? []) out.push({ name: f.name, severity: f.severity, uri: f.uri, attributes: f.attributes?.map((a) => ({ key: a.key, value: a.value })) });
          for (const f of r.imageScanFindings?.enhancedFindings ?? []) {
            const v = f.packageVulnerabilityDetails;
            const pkg = v?.vulnerablePackages?.[0];
            out.push({
              name: v?.vulnerabilityId ?? f.title, severity: f.severity, uri: v?.sourceUrl,
              attributes: [...(pkg?.name ? [{ key: "package_name", value: pkg.name }] : []), ...(pkg?.version ? [{ key: "package_version", value: pkg.version }] : [])],
            });
          }
          nextToken = r.nextToken;
          if (!nextToken || ctx.signal?.aborted) break;
        }
      } catch (e) {
        if ((e as { name?: string }).name === "ScanNotFoundException") return null;
        throw e;
      }
      return out;
    },
  };
}

function simApi(region: string): EcrApi {
  return {
    repositories: async () => simRepositories(region),
    imagesById: async (repository, ids) => simImagesById(region, repository, ids),
    firstPage: async (repository) => simFirstPage(region, repository),
    lifecycle: async (repository) => simLifecycle(region, repository),
    tags: async (arn) => simTags(region, arn.split(":repository/")[1] ?? ""),
    findings: async (repository) => simFindings(region, repository),
  };
}

// Every container ECS runs (all regions), from the shared ECS discovery — the same pass the ecs provider reads. Waited
// for until `until` at most; never thrown (the repositories are listed either way).
async function ecsUses(ctx: ProviderContext, home: string, until: number): Promise<{ uses?: EcsImageUse[]; why?: string }> {
  const read = (async () => {
    const inv = await inventory();
    const out: EcsImageUse[] = [];
    let failed = 0;
    await Promise.all(
      [...inv.catalogs.values()].map(async (cat) => {
        const services = await servicesOf(cat.env.cluster, cat.env.region).catch(() => (failed++, [] as RawService[]));
        for (const s of services) {
          const service = keys.ecsService(cat.env.cluster, s.name, cat.env.region, home);
          const hidden = !!cat.meta.get(s.name)?.hidden;
          const running = s.tasks.filter((x) => x.lastStatus === "RUNNING");
          for (const c of s.taskDef?.containers ?? []) {
            const digest = running.map((x) => x.imageDigests?.[c.name]).find(Boolean);
            out.push({ service, label: `${cat.env.id}/${s.name}`, container: c.name, image: c.image, ...(digest ? { digest } : {}), ...(hidden ? { hidden } : {}) });
          }
        }
      }),
    );
    if (failed) ctx.note(`ecr: ${failed} ECS cluster(s) couldn't be read — their images aren't checked`);
    return out;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ why: string }>((resolve) => {
    timer = setTimeout(() => resolve({ why: "ECS discovery still running" }), Math.max(500, until - Date.now()));
    ctx.signal.addEventListener("abort", () => resolve({ why: "deadline" }), { once: true });
  });
  try {
    return await Promise.race([read.then((uses) => ({ uses }), (e) => ({ why: errText(e) })), late]);
  } finally {
    clearTimeout(timer);
  }
}

const byKey = <T,>(keys: string[], r: { results: (T | undefined)[]; state: EnrichState[] }): Record<string, Read<T>> =>
  Object.fromEntries(keys.map((k, i) => [k, { ...(r.results[i] !== undefined ? { value: r.results[i] } : {}), state: r.state[i] }]));

async function discover(ctx: ProviderContext, api: EcrApi) {
  const home = ctx.home ?? homeRegion();
  const now = Date.now();
  const until = budget();
  const usesP = ecsUses(ctx, home, until);
  const repos = (await api.repositories(ctx)).filter((r) => r.repositoryName && r.repositoryArn);
  const o = { region: ctx.region, accountId: ctx.accountId, now, linkPulls: ctx.region === home };
  ctx.checkpoint?.(ecrResults({ repos }, o));

  const { uses, why } = await usesP;
  if (why) ctx.note(`ecr: images ECS runs not checked (${why})`);
  const inUse = usesByRepo(uses ?? [], ctx.region, ctx.accountId);
  const used = repos.filter((r) => inUse.has(r.repositoryArn!));
  const arns = repos.map((r) => r.repositoryArn!);
  const [running, pages, lifecycle, tags] = await Promise.all([
    enrich(ctx, used, { label: "ecr: images ECS runs", max: used.length, until }, async (r) => {
      const found: RawImage[] = [];
      // Batches of ≤100 ids, one after another (the per-item worker pool already bounds the concurrency); a batch with a
      // missing id is split until the missing one stands alone (describeFound), so the rest still resolve.
      for (const ids of imageIdBatches(inUse.get(r.repositoryArn!)!)) found.push(...(await describeFound(ids, (x) => api.imagesById(r.repositoryName!, x))));
      return found;
    }),
    enrich(ctx, repos, { label: "ecr: images", max: FIRST_PAGES, until }, (r) => api.firstPage(r.repositoryName!, PAGE)),
    enrich(ctx, repos, { label: "ecr: lifecycle policies", max: FIRST_PAGES, until }, (r) => api.lifecycle(r.repositoryName!)),
    enrich(ctx, repos, { label: "ecr: tags", max: TAG_READS, until }, (r) => api.tags(r.repositoryArn!)),
  ]);
  const raw: EcrRaw = {
    repos,
    inUse: byKey(used.map((r) => r.repositoryArn!), running),
    firstPage: byKey(arns, pages),
    // "not found" (no policy) comes back from enrich as ok + undefined: that is "none".
    lifecycle: Object.fromEntries(arns.map((k, i) => [k, { value: lifecycle.results[i] ?? null, state: lifecycle.state[i] }])),
    tags: byKey(arns, tags),
  };
  return ecrResults(raw, { ...o, uses: uses ?? [] });
}

export const ecrProvider: Provider = {
  id: "ecr",
  label: "ECR repositories",
  kinds: ["ecr-repository"],
  scope: "regional",
  covers: ["ecr:repository"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:GetLifecyclePolicy", "ecr:ListTagsForResource", "ecr:DescribeImageScanFindings"],
  discover: (ctx) => discover(ctx, ctx.mock ? simApi(ctx.region) : realApi(ctx.region, ctx)),
  // The newest images (the first 100 the API returns, sorted here) and what the scan found in the images ECS runs
  // (facts.tagDigests, at most 5).
  async detail(r, ctx) {
    const p = parseArn(r.key);
    const region = p?.region || ctx.region;
    const repository = p?.id ?? r.name;
    const api = ctx.mock ? simApi(region) : realApi(region, ctx);
    const soft = softly(ctx, "ecr", { service: "ecr" });
    const digests = [...new Set((Array.isArray(r.facts?.tagDigests) ? (r.facts.tagDigests as string[]) : []).map((x) => x.split("|")[1]).filter(Boolean))].slice(0, FINDINGS_IMAGES);
    const [page, findings] = await Promise.all([
      soft(() => api.firstPage(repository, DETAIL_IMAGES)),
      // undefined = couldn't be read (denied, failed): the panel says so instead of "no findings".
      Promise.all(digests.map(async (d) => ({ image: d.slice(0, 19), findings: await soft(() => api.findings(repository, d)) }))),
    ]);
    return ecrDetail(r.key, page?.images, findings, r.facts, page?.more);
  },
};
