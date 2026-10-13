// ECR repositories, pure part (audit §6 A.2 #11, F68): DescribeRepositories + DescribeImages (the images ECS runs, asked
// for by tag and digest, and the first page of each repository) + lifecycle policy + tags, real or simulated →
// Resources, and the ECS → repository `pulls` links. No AWS calls and no `server-only`, so node:test runs it (ecr.test.ts).
// - Images are named the way ECS names them; they are parsed with parseImageRef (../discover.ts) — never a second
//   parser. Only ECR images (<account>.dkr.ecr.<region>.amazonaws.com/<repository>) count; Docker Hub, ghcr.io and ECR
//   Public images name no repository here.
// - Health: a tag ECS runs that the repository no longer has, or a critical scan finding in an image ECS runs → warning.
//   Everything else is ok; what an image's scan found in detail is read only when the panel opens.
// - Facts (F68): tagDigests ["<tag>|<digest>"] for the tags ECS references — what a mutable tag points to now, so a
//   revision that names "production" can be told apart from the image its tasks actually run.
// - Idle: lastActivityAt = the newest of any image's push and last recorded pull (ECR records pulls about daily); a
//   repository read empty counts from its creation. No activity metric (the audit design: pulls are the evidence).
import { parseImageRef } from "../discover.ts";
import { arnOf } from "./arn.ts";
import { awsTime, clip, enrichmentOf, fmtBytes, fmtTime, kmsKeyRef, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

type When = Date | string | number;

// DescribeRepositories' Repository, the parts the map uses.
export interface RawRepository {
  repositoryArn?: string;
  registryId?: string;
  repositoryName?: string;
  repositoryUri?: string;
  createdAt?: When;
  imageTagMutability?: string; // MUTABLE | IMMUTABLE | MUTABLE_WITH_EXCLUSION | IMMUTABLE_WITH_EXCLUSION
  imageScanningConfiguration?: { scanOnPush?: boolean };
  encryptionConfiguration?: { encryptionType?: string; kmsKey?: string }; // AES256 | KMS | KMS_DSSE
}

// DescribeImages' ImageDetail, the parts the map uses.
export interface RawImage {
  imageDigest?: string;
  imageTags?: string[];
  imageSizeInBytes?: number;
  imagePushedAt?: When;
  lastRecordedPullTime?: When;
  imageStatus?: string;
  imageScanStatus?: { status?: string; description?: string };
  imageScanFindingsSummary?: { findingSeverityCounts?: Record<string, number>; imageScanCompletedAt?: When };
}

// One container ECS runs, from the ECS discovery (task definitions + running tasks).
export interface EcsImageUse {
  service: string; // the ECS service's key (region-aware: keys.ecsService)
  label: string; // "production/api"
  container: string;
  image: string; // as the task definition names it
  digest?: string; // what the service's running tasks report for that container (RawTask.imageDigests)
  hidden?: boolean; // a service the console hides (no map node, so no link)
}

export interface Read<T> { value?: T; state: EnrichState }
export interface Lifecycle { rules: number; descriptions: string[] }

// What one region's run read. Records are keyed by the repository ARN.
export interface EcrRaw {
  repos: RawRepository[];
  firstPage?: Record<string, Read<{ images: RawImage[]; more: boolean }>>;
  inUse?: Record<string, Read<RawImage[]>>; // DescribeImages by imageIds; missing ids are simply absent
  lifecycle?: Record<string, Read<Lifecycle | null>>; // null = no policy (LifecyclePolicyNotFoundException)
  tags?: Record<string, Read<{ Key?: string; Value?: string }[]>>;
}

export interface EcrOptions {
  region: string;
  accountId?: string;
  now?: number;
  uses?: EcsImageUse[]; // every container ECS runs, any region (the run keeps those whose registry is its own)
  linkPulls?: boolean; // the home run draws ECS → repository for every region (once)
}

// An ECR image reference → its repository's ARN and the tag or digest it names. undefined for other registries.
export function ecrImageOf(image: string | undefined): { arn: string; region: string; account: string; repository: string; tag?: string; digest?: string } | undefined {
  const s = image?.trim();
  if (!s) return undefined;
  const ref = parseImageRef(s);
  if (!ref.ecr || !ref.region) return undefined;
  const account = ref.registry.split(".")[0];
  // parseImageRef defaults a bare name to "latest"; with a digest the tag (if any) is informational only.
  return { arn: arnOf.ecrRepository(ref.region, account, ref.repository), region: ref.region, account, repository: ref.repository, tag: ref.tag, digest: ref.digest };
}

export interface RepoUse {
  repository: string;
  tags: string[]; // tags ECS references (when the image is named by tag)
  digests: string[]; // digests ECS references or runs
  users: { service: string; label: string; ref: string; hidden?: boolean }[]; // ref: the tag, or "@sha256:<12>"
}

const shortDigest = (d: string) => `@${d.slice(0, 19)}`; // "@sha256:" + 12 hex digits

// The images ECS runs, per repository ARN, in one region (and account, when known).
export function usesByRepo(uses: EcsImageUse[], region: string, account?: string): Map<string, RepoUse> {
  const out = new Map<string, RepoUse>();
  for (const u of uses) {
    const img = ecrImageOf(u.image);
    if (!img || img.region !== region || (account && img.account !== account)) continue;
    const r = out.get(img.arn) ?? { repository: img.repository, tags: [], digests: [], users: [] };
    if (img.digest) r.digests.push(img.digest);
    else if (img.tag) r.tags.push(img.tag);
    if (u.digest && u.digest !== img.digest) r.digests.push(u.digest);
    const ref = img.digest ? shortDigest(img.digest) : img.tag ?? "latest";
    if (!r.users.some((x) => x.service === u.service && x.ref === ref)) r.users.push({ service: u.service, label: u.label, ref, ...(u.hidden ? { hidden: true } : {}) });
    out.set(img.arn, r);
  }
  for (const r of out.values()) {
    r.tags = [...new Set(r.tags)].sort();
    r.digests = [...new Set(r.digests)].sort();
  }
  return out;
}

// DescribeImages imageIds for one repository's uses, in batches of at most 100 (the API's limit).
export const IMAGE_IDS_MAX = 100;
export function imageIdBatches(u: RepoUse): { imageTag?: string; imageDigest?: string }[][] {
  const ids = [...u.tags.map((imageTag) => ({ imageTag })), ...u.digests.map((imageDigest) => ({ imageDigest }))];
  const out: { imageTag?: string; imageDigest?: string }[][] = [];
  for (let i = 0; i < ids.length; i += IMAGE_IDS_MAX) out.push(ids.slice(i, i + IMAGE_IDS_MAX));
  return out;
}

// DescribeImages by imageIds rejects the whole call with ImageNotFoundException when any one id is missing (verified
// live: one deleted tag among existing ones → no imageDetails at all), and a missing tag is exactly what the health
// check looks for. So a rejected batch is asked again in halves until each missing id stands alone: the images that
// exist still come back, a missing one is simply absent, at about (missing ids × log₂ batch) extra calls.
export const imageNotFound = (e: unknown) => (e as { name?: string } | undefined)?.name === "ImageNotFoundException";
export async function describeFound<I, T>(ids: I[], call: (ids: I[]) => Promise<T[]>, missing: (e: unknown) => boolean = imageNotFound): Promise<T[]> {
  if (!ids.length) return [];
  try {
    return await call(ids);
  } catch (e) {
    if (!missing(e)) throw e;
    if (ids.length === 1) return [];
    const half = Math.ceil(ids.length / 2);
    return [...(await describeFound(ids.slice(0, half), call, missing)), ...(await describeFound(ids.slice(half), call, missing))];
  }
}

// ECS service → repository, one link per pair (labels joined), every region: the home run makes them once.
export function pullLinks(uses: EcsImageUse[]): Link[] {
  const byPair = new Map<string, { from: string; to: string; refs: string[]; evidence: string[] }>();
  for (const u of uses) {
    if (u.hidden) continue;
    const img = ecrImageOf(u.image);
    if (!img) continue;
    const id = `${u.service} ${img.arn}`;
    const l = byPair.get(id) ?? { from: u.service, to: img.arn, refs: [], evidence: [] };
    const ref = img.digest ? shortDigest(img.digest) : img.tag ?? "latest";
    if (!l.refs.includes(ref)) l.refs.push(ref);
    l.evidence.push(`task definition container ${u.container} image ${clip(u.image, 200)}`);
    byPair.set(id, l);
  }
  return [...byPair.values()].map((l) => ({ from: l.from, to: l.to, kind: "pulls", label: clip(l.refs.join(", "), 80), evidence: l.evidence.join("; ") }));
}

const critical = (i: RawImage) => i.imageScanFindingsSummary?.findingSeverityCounts?.CRITICAL ?? 0;
const lastUse = (i: RawImage) => Math.max(awsTime(i.lastRecordedPullTime) ?? 0, awsTime(i.imagePushedAt) ?? 0) || undefined;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function repoHealth(use: RepoUse | undefined, found: RawImage[] | undefined, read: EnrichState | undefined): { health: Health; reason?: string; tagDigests: string[]; missing: string[] } {
  if (!use) return { health: "ok", tagDigests: [], missing: [] };
  const images = found ?? [];
  const byTag = new Map<string, RawImage>();
  for (const i of images) for (const t of i.imageTags ?? []) byTag.set(t, i);
  const byDigest = new Map(images.filter((i) => i.imageDigest).map((i) => [i.imageDigest!, i]));
  const tagDigests = use.tags.filter((t) => byTag.get(t)?.imageDigest).map((t) => `${t}|${byTag.get(t)!.imageDigest}`);
  if (found === undefined || read !== "ok") return { health: "ok", tagDigests, missing: [] };
  // Missing = asked for and not answered. Digests come from running tasks too, so only an image a task definition names
  // by digest counts; tags count always.
  const named = new Set(use.users.map((u) => u.ref));
  const missing = [
    ...use.tags.filter((t) => !byTag.has(t)),
    ...use.digests.filter((d) => !byDigest.has(d) && named.has(shortDigest(d))).map(shortDigest),
  ];
  const reasons: string[] = [];
  if (missing.length) {
    const who = use.users.filter((u) => missing.includes(u.ref) && !u.hidden).map((u) => u.label);
    reasons.push(`${missing.length === 1 ? `image ${missing[0]}` : `${missing.length} images`} ECS runs ${missing.length === 1 ? "is" : "are"} no longer in the repository${who.length ? ` (${[...new Set(who)].join(", ")})` : ""} — new tasks can't start`);
  }
  const vulnerable = images.filter((i) => critical(i) > 0);
  if (vulnerable.length) {
    const n = vulnerable.reduce((a, i) => a + critical(i), 0);
    const tags = vulnerable.flatMap((i) => (i.imageTags ?? []).filter((t) => use.tags.includes(t)));
    reasons.push(`${plural(n, "critical vulnerability", "critical vulnerabilities")} in ${vulnerable.length === 1 ? "an image" : `${vulnerable.length} images`} ECS runs${tags.length ? ` (${clip(tags.join(", "), 60)})` : ""}`);
  }
  return { health: reasons.length ? "warning" : "ok", ...(reasons.length ? { reason: reasons.join("; ") } : {}), tagDigests, missing };
}

const encryption = (r: RawRepository) => {
  const e = r.encryptionConfiguration;
  if (!e?.encryptionType || e.encryptionType === "AES256") return "AES-256 (ECR managed)";
  return `${e.encryptionType === "KMS_DSSE" ? "KMS (dual-layer)" : "KMS"} ${e.kmsKey ?? "(AWS managed key)"}`;
};

export const ecrConsoleUrl = (region: string, account: string, name: string) =>
  `https://${region}.console.aws.amazon.com/ecr/repositories/private/${account}/${encodeURIComponent(name)}?region=${region}`;

export function ecrResults(raw: EcrRaw, o: EcrOptions): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const uses = usesByRepo(o.uses ?? [], o.region, o.accountId);
  for (const r of raw.repos) {
    const name = r.repositoryName;
    if (!name) continue;
    const account = r.registryId ?? r.repositoryArn?.split(":")[4] ?? o.accountId ?? "";
    const key = r.repositoryArn ?? arnOf.ecrRepository(o.region, account, name);
    const page = raw.firstPage?.[key];
    const inUse = raw.inUse?.[key];
    const life = raw.lifecycle?.[key];
    const tagRead = raw.tags?.[key];
    const use = uses.get(key);
    const h = repoHealth(use, inUse?.value, inUse?.state);
    const seen = [...(page?.value?.images ?? []), ...(inUse?.value ?? [])];
    const created = awsTime(r.createdAt);
    const last = Math.max(0, ...seen.map((i) => lastUse(i) ?? 0)) || undefined;
    const lastActivityAt = last ?? (page?.state === "ok" && page.value && !page.value.images.length ? created : undefined);
    const pushed = seen.reduce((a, i) => Math.max(a, awsTime(i.imagePushedAt) ?? 0), 0);
    const pulled = seen.reduce((a, i) => Math.max(a, awsTime(i.lastRecordedPullTime) ?? 0), 0);
    const facts: Facts = {};
    if (h.tagDigests.length) facts.tagDigests = h.tagDigests.sort();
    const users = use?.users.filter((u) => !u.hidden) ?? [];
    const enrichment = enrichmentOf({ images: page?.state, inUse: use ? inUse?.state ?? "skipped" : undefined, lifecycle: life?.state, tags: tagRead?.state });
    const kms = r.encryptionConfiguration?.encryptionType?.startsWith("KMS") ? kmsKeyRef(r.encryptionConfiguration.kmsKey ?? "alias/aws/ecr", o.region, account || undefined) : undefined;
    resources.push({
      key, kind: "ecr-repository", provider: "ecr", name, region: o.region,
      ...tagsOf(tagRead?.state === "ok" ? tagRead.value ?? [] : undefined),
      health: h.health, ...(h.reason ? { healthReason: h.reason } : {}),
      ...(Object.keys(facts).length ? { facts } : {}), ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "URI", value: r.repositoryUri, mono: true },
        { label: "Images", value: page?.state === "ok" && page.value ? `${page.value.images.length.toLocaleString("en-US")}${page.value.more ? "+" : ""}` : unread("images", page?.state) },
        { label: "Used by", value: users.length ? clip(users.map((u) => `${u.label} (${u.ref})`).join(", "), 240) : undefined },
        { label: "Tag mutability", value: r.imageTagMutability ? r.imageTagMutability.toLowerCase().replace(/_/g, " ") : undefined },
        { label: "Scan on push", value: r.imageScanningConfiguration ? (r.imageScanningConfiguration.scanOnPush ? "on" : "off") : undefined },
        { label: "Encryption", value: encryption(r) },
        { label: "Lifecycle policy", value: !life ? undefined : life.state !== "ok" ? unread("lifecycle policy", life.state) : life.value ? `${plural(life.value.rules, "rule")}${life.value.descriptions.length ? `: ${clip(life.value.descriptions.join("; "), 120)}` : ""}` : "none — images are kept forever" },
        { label: "Last push", value: pushed ? fmtTime(pushed) : undefined },
        { label: "Last pull", value: pulled ? fmtTime(pulled) : undefined },
        { label: "Created", value: created !== undefined ? fmtTime(created) : undefined },
      ]),
      aliases: [...new Set([name, ...(r.repositoryUri ? [r.repositoryUri] : [])])],
      consoleUrl: ecrConsoleUrl(o.region, account, name),
      ...(created !== undefined ? { createdAt: created } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), ...(o.now ? { observedAt: o.now } : {}),
    });
    if (kms) links.push({ from: kms, to: key, kind: "encrypts", label: "images", evidence: "ECR repository encryption key (encryptionConfiguration.kmsKey)" });
  }
  if (o.linkPulls) links.push(...pullLinks(o.uses ?? []));
  return { resources, links, mentions: [] };
}

// GetLifecyclePolicy's lifecyclePolicyText → rule count and descriptions (a policy is configuration, not a secret).
export function lifecycleOf(text: string | undefined): Lifecycle | null {
  if (!text) return null;
  try {
    const rules = (JSON.parse(text) as { rules?: { description?: unknown }[] }).rules ?? [];
    return { rules: rules.length, descriptions: rules.map((x) => (typeof x.description === "string" ? clip(x.description, 80) : "")).filter(Boolean) };
  } catch {
    return { rules: 0, descriptions: [] };
  }
}

// DescribeImageScanFindings' findings, the parts the panel shows.
export interface RawFinding { name?: string; severity?: string; uri?: string; attributes?: { key?: string; value?: string }[] }
const SEVERITY = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL", "UNDEFINED"];
const counts = (i: RawImage) => Object.entries(i.imageScanFindingsSummary?.findingSeverityCounts ?? {}).sort(([a], [b]) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b)).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ");

// What the scan found in one image ECS runs: the findings, null when the image was never scanned, undefined when they
// couldn't be read (denied or failed — never shown as "no findings").
export interface ImageFindings { image: string; findings?: RawFinding[] | null }

function findingsSection(findings: ImageFindings[], rows: string[][]) {
  const read = findings.filter((f) => Array.isArray(f.findings));
  const unscanned = findings.filter((f) => f.findings === null).length;
  const unread = findings.length - read.length - unscanned;
  const also = [unscanned ? `${plural(unscanned, "image")} never scanned` : "", unread ? `findings of ${plural(unread, "image")} couldn't be read` : ""].filter(Boolean).join("; ");
  if (rows.length) return { title: "Critical and high findings in images ECS runs", table: { columns: ["Image", "Severity", "Finding", "Package", "Version"], rows: rows.slice(0, 50) }, ...(also ? { note: `Also: ${also}.` } : {}) };
  if (read.length) return { title: "Scan findings in images ECS runs", note: `No critical or high findings${also ? `; ${also}` : ""}.` };
  return { title: "Scan findings in images ECS runs", note: unread ? "The scan findings couldn't be read." : "These images were never scanned." };
}

// The panel: the newest images (the API doesn't sort; this does), and what the scan found in the images ECS runs.
// `more`: the repository holds more images than were read — ECR doesn't sort, so "newest" is only among those read.
export function ecrDetail(key: string, images: RawImage[] | undefined, findings: ImageFindings[] = [], facts?: Facts, more = false): ResourceDetail {
  const sorted = [...(images ?? [])].sort((a, b) => (awsTime(b.imagePushedAt) ?? 0) - (awsTime(a.imagePushedAt) ?? 0)).slice(0, 50);
  const running = Array.isArray(facts?.tagDigests) ? (facts.tagDigests as string[]) : [];
  const rows = findings.flatMap((f) =>
    (f.findings ?? [])
      .filter((x) => x.severity === "CRITICAL" || x.severity === "HIGH")
      .sort((a, b) => SEVERITY.indexOf(a.severity!) - SEVERITY.indexOf(b.severity!))
      .map((x) => [f.image, x.severity ?? "", clip(x.name ?? "", 40), clip(x.attributes?.find((a) => a.key === "package_name")?.value ?? "", 40), clip(x.attributes?.find((a) => a.key === "package_version")?.value ?? "", 30)]),
  );
  return {
    key,
    sections: [
      ...(running.length ? [{ title: "Tags ECS runs", table: { columns: ["Tag", "Points to"], rows: running.map((x) => { const [t, d] = x.split("|"); return [t, d.slice(0, 19)]; }) } }] : []),
      images === undefined
        ? { title: "Images", note: "The images couldn't be read." }
        : sorted.length
          ? {
              title: `Images (newest ${sorted.length})`,
              ...(more ? { note: `The repository holds more images; ECR doesn't sort them, so these are the newest of the first ${(images ?? []).length.toLocaleString("en-US")} it returned.` } : {}),
              table: {
                columns: ["Tags", "Digest", "Pushed", "Last pull", "Size", "Scan"],
                rows: sorted.map((i) => [clip((i.imageTags ?? []).join(", ") || "untagged", 60), (i.imageDigest ?? "").slice(0, 19), fmtTime(awsTime(i.imagePushedAt)), i.lastRecordedPullTime ? fmtTime(awsTime(i.lastRecordedPullTime)) : "—", fmtBytes(i.imageSizeInBytes), counts(i) || i.imageScanStatus?.status?.toLowerCase() || "—"]),
              },
            }
          : { title: "Images", note: "The repository is empty." },
      ...(findings.length ? [findingsSection(findings, rows)] : []),
    ],
  };
}
